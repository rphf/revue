// Package store is the SQLite persistence layer. It is mechanical:
// domain rules live in the server, except the KTD8 review state
// machine and draft visibility, which are enforced here because every
// caller must agree on them.
package store

import (
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Review states (KTD8).
const (
	StateOpen     = "open"
	StateApproved = "approved"
	StateClosed   = "closed"
)

// Verdicts (R5).
const (
	VerdictComment        = "comment"
	VerdictRequestChanges = "request_changes"
	VerdictApprove        = "approve"
)

// Author roles.
const (
	RoleReviewer = "reviewer"
	RoleAgent    = "agent"
)

// Anchor sides, matching @pierre/diffs DiffLineAnnotation (KTD2).
const (
	SideAdditions = "additions"
	SideDeletions = "deletions"
)

// Anchor states.
const (
	AnchorLive     = "live"
	AnchorOutdated = "outdated"
)

// File statuses.
const (
	FileAdded    = "added"
	FileModified = "modified"
	FileDeleted  = "deleted"
	FileRenamed  = "renamed"
)

// ErrIllegalTransition is returned for review state changes outside
// the KTD8 machine.
var ErrIllegalTransition = errors.New("illegal review state transition")

// ErrNotDraft is returned when editing or deleting a comment that has
// already been submitted.
var ErrNotDraft = errors.New("comment is not a draft")

// ErrNotFound is returned when a row does not exist.
var ErrNotFound = errors.New("not found")

// ErrReviewNotOpen is returned when creating a round on a review that
// is not open (rounds exist only under open, KTD8).
var ErrReviewNotOpen = errors.New("review is not open")

type Review struct {
	ID         int64     `json:"id"`
	RepoRoot   string    `json:"repoRoot"`
	Branch     string    `json:"branch"`
	SourceArgs []string  `json:"sourceArgs"`
	State      string    `json:"state"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type Round struct {
	ID        int64     `json:"id"`
	ReviewID  int64     `json:"reviewId"`
	Seq       int       `json:"seq"`
	Patch     string    `json:"patch"`
	CreatedAt time.Time `json:"createdAt"`
}

type RoundFile struct {
	ID       int64  `json:"id"`
	RoundID  int64  `json:"roundId"`
	Path     string `json:"path"`
	OldPath  string `json:"oldPath,omitempty"`
	Status   string `json:"status"`
	OldBlob  string `json:"oldBlob,omitempty"`
	NewBlob  string `json:"newBlob,omitempty"`
	IsBinary bool   `json:"isBinary"`
}

// NewRoundFile carries file content into CreateRound; the store hashes
// and dedupes blobs (KTD4).
type NewRoundFile struct {
	Path       string
	OldPath    string
	Status     string
	IsBinary   bool
	OldContent []byte // nil when the file did not exist (added) or is binary
	NewContent []byte // nil when the file is gone (deleted) or is binary
}

type Thread struct {
	ID            int64     `json:"id"`
	ReviewID      int64     `json:"reviewId"`
	OriginRoundID int64     `json:"originRoundId"`
	Resolved      bool      `json:"resolved"`
	CreatedAt     time.Time `json:"createdAt"`
}

type Anchor struct {
	Path      string `json:"path"`
	Side      string `json:"side"`
	StartLine *int   `json:"startLine,omitempty"`
	Line      int    `json:"line"`
}

type ThreadAnchor struct {
	ID       int64  `json:"id"`
	ThreadID int64  `json:"threadId"`
	RoundID  int64  `json:"roundId"`
	Anchor
	State    string `json:"state"`
	HunkHash string `json:"hunkHash,omitempty"`
}

type Comment struct {
	ID           int64     `json:"id"`
	ThreadID     int64     `json:"threadId"`
	AuthorRole   string    `json:"authorRole"`
	Body         string    `json:"body"`
	Draft        bool      `json:"draft"`
	SubmissionID *int64    `json:"submissionId,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
}

type Submission struct {
	ID        int64     `json:"id"`
	ReviewID  int64     `json:"reviewId"`
	RoundID   int64     `json:"roundId"`
	Verdict   string    `json:"verdict"`
	Summary   string    `json:"summary,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

type Event struct {
	ID        int64           `json:"id"`
	ReviewID  int64           `json:"reviewId"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"createdAt"`
}

// dbtx is satisfied by *sql.DB and *sql.Tx.
type dbtx interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

type Store struct {
	q  dbtx
	db *sql.DB // nil when bound to a transaction
}

// Open opens (creating if needed) the SQLite database at path and
// applies pending migrations.
func Open(path string) (*Store, error) {
	dsn := "file:" + path + "?_pragma=foreign_keys(1)&_pragma=journal_mode(wal)&_pragma=busy_timeout(5000)&_pragma=synchronous(normal)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// A single connection sidesteps SQLITE_BUSY entirely; revue's
	// write volume is one human and one agent.
	db.SetMaxOpenConns(1)
	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{q: db, db: db}, nil
}

func (s *Store) Close() error {
	if s.db == nil {
		return nil
	}
	return s.db.Close()
}

// WithTx runs fn with a Store bound to a single transaction,
// committing if fn returns nil.
func (s *Store) WithTx(fn func(*Store) error) error {
	if s.db == nil {
		return errors.New("store: nested transactions are not supported")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	if err := fn(&Store{q: tx}); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

func migrate(db *sql.DB) error {
	names, err := fs.Glob(migrationsFS, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	for _, name := range names {
		base := strings.TrimPrefix(name, "migrations/")
		numStr, _, ok := strings.Cut(base, "_")
		if !ok {
			return fmt.Errorf("store: migration %q is not numbered", name)
		}
		num, err := strconv.Atoi(numStr)
		if err != nil {
			return fmt.Errorf("store: migration %q is not numbered: %w", name, err)
		}
		if num <= version {
			continue
		}
		sqlText, err := migrationsFS.ReadFile(name)
		if err != nil {
			return err
		}
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(string(sqlText)); err != nil {
			tx.Rollback()
			return fmt.Errorf("store: applying %s: %w", name, err)
		}
		// PRAGMA cannot be parameterized; num comes from the
		// filename we just parsed as an int.
		if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", num)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func parseTime(s string) time.Time {
	t, _ := time.Parse(time.RFC3339Nano, s)
	return t
}

// --- Reviews ---

func (s *Store) CreateReview(repoRoot, branch string, sourceArgs []string) (*Review, error) {
	args, err := json.Marshal(sourceArgs)
	if err != nil {
		return nil, err
	}
	ts := now()
	res, err := s.q.Exec(
		"INSERT INTO reviews (repo_root, branch, source_args, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		repoRoot, branch, string(args), StateOpen, ts, ts,
	)
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return s.GetReview(id)
}

func (s *Store) scanReview(row *sql.Row) (*Review, error) {
	var r Review
	var args, created, updated string
	err := row.Scan(&r.ID, &r.RepoRoot, &r.Branch, &args, &r.State, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(args), &r.SourceArgs); err != nil {
		return nil, err
	}
	r.CreatedAt, r.UpdatedAt = parseTime(created), parseTime(updated)
	return &r, nil
}

const reviewCols = "id, repo_root, branch, source_args, state, created_at, updated_at"

func (s *Store) GetReview(id int64) (*Review, error) {
	return s.scanReview(s.q.QueryRow("SELECT "+reviewCols+" FROM reviews WHERE id = ?", id))
}

// ListReviews returns all reviews for a repo, newest first.
func (s *Store) ListReviews(repoRoot string) ([]*Review, error) {
	rows, err := s.q.Query("SELECT "+reviewCols+" FROM reviews WHERE repo_root = ? ORDER BY id DESC", repoRoot)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Review
	for rows.Next() {
		var r Review
		var args, created, updated string
		if err := rows.Scan(&r.ID, &r.RepoRoot, &r.Branch, &args, &r.State, &created, &updated); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(args), &r.SourceArgs); err != nil {
			return nil, err
		}
		r.CreatedAt, r.UpdatedAt = parseTime(created), parseTime(updated)
		out = append(out, &r)
	}
	return out, rows.Err()
}

// OpenReviewsForBranch returns open reviews on a branch, newest first.
func (s *Store) OpenReviewsForBranch(repoRoot, branch string) ([]*Review, error) {
	rows, err := s.q.Query(
		"SELECT "+reviewCols+" FROM reviews WHERE repo_root = ? AND branch = ? AND state = ? ORDER BY id DESC",
		repoRoot, branch, StateOpen,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Review
	for rows.Next() {
		var r Review
		var args, created, updated string
		if err := rows.Scan(&r.ID, &r.RepoRoot, &r.Branch, &args, &r.State, &created, &updated); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(args), &r.SourceArgs); err != nil {
			return nil, err
		}
		r.CreatedAt, r.UpdatedAt = parseTime(created), parseTime(updated)
		out = append(out, &r)
	}
	return out, rows.Err()
}

// legalTransitions is the KTD8 machine.
var legalTransitions = map[string][]string{
	StateOpen:     {StateApproved, StateClosed},
	StateApproved: {StateOpen},
	StateClosed:   {StateOpen},
}

// SetReviewState transitions a review, enforcing KTD8.
func (s *Store) SetReviewState(id int64, state string) error {
	r, err := s.GetReview(id)
	if err != nil {
		return err
	}
	legal := false
	for _, next := range legalTransitions[r.State] {
		if next == state {
			legal = true
			break
		}
	}
	if !legal {
		return fmt.Errorf("%w: %s -> %s", ErrIllegalTransition, r.State, state)
	}
	_, err = s.q.Exec("UPDATE reviews SET state = ?, updated_at = ? WHERE id = ?", state, now(), id)
	return err
}

// --- Rounds and blobs ---

func blobHash(content []byte) string {
	h := sha256.Sum256(content)
	return hex.EncodeToString(h[:])
}

// PutBlob stores content if absent and returns its hash.
func (s *Store) PutBlob(content []byte) (string, error) {
	hash := blobHash(content)
	_, err := s.q.Exec("INSERT INTO blobs (hash, content) VALUES (?, ?) ON CONFLICT (hash) DO NOTHING", hash, content)
	return hash, err
}

func (s *Store) Blob(hash string) ([]byte, error) {
	var content []byte
	err := s.q.QueryRow("SELECT content FROM blobs WHERE hash = ?", hash).Scan(&content)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return content, err
}

// CreateRound freezes a diff snapshot as the review's next round.
// Rounds exist only while the review is open (KTD8).
func (s *Store) CreateRound(reviewID int64, patch string, files []NewRoundFile) (*Round, error) {
	r, err := s.GetReview(reviewID)
	if err != nil {
		return nil, err
	}
	if r.State != StateOpen {
		return nil, fmt.Errorf("%w: %s", ErrReviewNotOpen, r.State)
	}
	var seq int
	if err := s.q.QueryRow("SELECT COALESCE(MAX(seq), 0) + 1 FROM rounds WHERE review_id = ?", reviewID).Scan(&seq); err != nil {
		return nil, err
	}
	res, err := s.q.Exec(
		"INSERT INTO rounds (review_id, seq, patch, created_at) VALUES (?, ?, ?, ?)",
		reviewID, seq, patch, now(),
	)
	if err != nil {
		return nil, err
	}
	roundID, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	for _, f := range files {
		var oldHash, newHash sql.NullString
		if f.OldContent != nil {
			h, err := s.PutBlob(f.OldContent)
			if err != nil {
				return nil, err
			}
			oldHash = sql.NullString{String: h, Valid: true}
		}
		if f.NewContent != nil {
			h, err := s.PutBlob(f.NewContent)
			if err != nil {
				return nil, err
			}
			newHash = sql.NullString{String: h, Valid: true}
		}
		if _, err := s.q.Exec(
			"INSERT INTO round_files (round_id, path, old_path, status, old_blob, new_blob, is_binary) VALUES (?, ?, ?, ?, ?, ?, ?)",
			roundID, f.Path, f.OldPath, f.Status, oldHash, newHash, f.IsBinary,
		); err != nil {
			return nil, err
		}
	}
	return s.RoundByID(roundID)
}

const roundCols = "id, review_id, seq, patch, created_at"

func (s *Store) scanRound(row *sql.Row) (*Round, error) {
	var r Round
	var created string
	err := row.Scan(&r.ID, &r.ReviewID, &r.Seq, &r.Patch, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	r.CreatedAt = parseTime(created)
	return &r, nil
}

func (s *Store) RoundByID(id int64) (*Round, error) {
	return s.scanRound(s.q.QueryRow("SELECT "+roundCols+" FROM rounds WHERE id = ?", id))
}

func (s *Store) GetRound(reviewID int64, seq int) (*Round, error) {
	return s.scanRound(s.q.QueryRow("SELECT "+roundCols+" FROM rounds WHERE review_id = ? AND seq = ?", reviewID, seq))
}

func (s *Store) LatestRound(reviewID int64) (*Round, error) {
	return s.scanRound(s.q.QueryRow("SELECT "+roundCols+" FROM rounds WHERE review_id = ? ORDER BY seq DESC LIMIT 1", reviewID))
}

func (s *Store) ListRounds(reviewID int64) ([]*Round, error) {
	rows, err := s.q.Query("SELECT "+roundCols+" FROM rounds WHERE review_id = ? ORDER BY seq", reviewID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Round
	for rows.Next() {
		var r Round
		var created string
		if err := rows.Scan(&r.ID, &r.ReviewID, &r.Seq, &r.Patch, &created); err != nil {
			return nil, err
		}
		r.CreatedAt = parseTime(created)
		out = append(out, &r)
	}
	return out, rows.Err()
}

func (s *Store) FilesForRound(roundID int64) ([]*RoundFile, error) {
	rows, err := s.q.Query(
		"SELECT id, round_id, path, old_path, status, COALESCE(old_blob, ''), COALESCE(new_blob, ''), is_binary FROM round_files WHERE round_id = ? ORDER BY path",
		roundID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*RoundFile
	for rows.Next() {
		var f RoundFile
		if err := rows.Scan(&f.ID, &f.RoundID, &f.Path, &f.OldPath, &f.Status, &f.OldBlob, &f.NewBlob, &f.IsBinary); err != nil {
			return nil, err
		}
		out = append(out, &f)
	}
	return out, rows.Err()
}

// --- Threads, anchors, comments ---

// CreateThread opens a thread anchored in a round with its first
// comment. Reviewer comments start as drafts (R5); agent comments are
// never drafts.
func (s *Store) CreateThread(reviewID, roundID int64, anchor Anchor, role, body string, draft bool) (*Thread, *Comment, error) {
	ts := now()
	res, err := s.q.Exec(
		"INSERT INTO threads (review_id, origin_round_id, resolved, created_at) VALUES (?, ?, 0, ?)",
		reviewID, roundID, ts,
	)
	if err != nil {
		return nil, nil, err
	}
	threadID, err := res.LastInsertId()
	if err != nil {
		return nil, nil, err
	}
	if err := s.UpsertAnchor(threadID, roundID, anchor, AnchorLive, ""); err != nil {
		return nil, nil, err
	}
	c, err := s.AddComment(threadID, role, body, draft)
	if err != nil {
		return nil, nil, err
	}
	t, err := s.GetThread(threadID)
	if err != nil {
		return nil, nil, err
	}
	return t, c, nil
}

func (s *Store) GetThread(id int64) (*Thread, error) {
	var t Thread
	var created string
	err := s.q.QueryRow("SELECT id, review_id, origin_round_id, resolved, created_at FROM threads WHERE id = ?", id).
		Scan(&t.ID, &t.ReviewID, &t.OriginRoundID, &t.Resolved, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	t.CreatedAt = parseTime(created)
	return &t, nil
}

// UpsertAnchor records where a thread sits in a given round (used at
// thread creation and by the anchoring engine on each new round).
func (s *Store) UpsertAnchor(threadID, roundID int64, anchor Anchor, state, hunkHash string) error {
	var start sql.NullInt64
	if anchor.StartLine != nil {
		start = sql.NullInt64{Int64: int64(*anchor.StartLine), Valid: true}
	}
	_, err := s.q.Exec(
		`INSERT INTO thread_anchors (thread_id, round_id, path, side, start_line, line, state, hunk_hash)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (thread_id, round_id) DO UPDATE SET
		   path = excluded.path, side = excluded.side, start_line = excluded.start_line,
		   line = excluded.line, state = excluded.state, hunk_hash = excluded.hunk_hash`,
		threadID, roundID, anchor.Path, anchor.Side, start, anchor.Line, state, hunkHash,
	)
	return err
}

func scanAnchors(rows *sql.Rows) ([]*ThreadAnchor, error) {
	defer rows.Close()
	var out []*ThreadAnchor
	for rows.Next() {
		var a ThreadAnchor
		var start sql.NullInt64
		if err := rows.Scan(&a.ID, &a.ThreadID, &a.RoundID, &a.Path, &a.Side, &start, &a.Line, &a.State, &a.HunkHash); err != nil {
			return nil, err
		}
		if start.Valid {
			v := int(start.Int64)
			a.StartLine = &v
		}
		out = append(out, &a)
	}
	return out, rows.Err()
}

const anchorCols = "id, thread_id, round_id, path, side, start_line, line, state, hunk_hash"

func (s *Store) AnchorsForRound(roundID int64) ([]*ThreadAnchor, error) {
	rows, err := s.q.Query("SELECT "+anchorCols+" FROM thread_anchors WHERE round_id = ?", roundID)
	if err != nil {
		return nil, err
	}
	return scanAnchors(rows)
}

func (s *Store) AnchorsForThread(threadID int64) ([]*ThreadAnchor, error) {
	rows, err := s.q.Query("SELECT "+anchorCols+" FROM thread_anchors WHERE thread_id = ? ORDER BY round_id", threadID)
	if err != nil {
		return nil, err
	}
	return scanAnchors(rows)
}

func (s *Store) AddComment(threadID int64, role, body string, draft bool) (*Comment, error) {
	res, err := s.q.Exec(
		"INSERT INTO comments (thread_id, author_role, body, draft, created_at) VALUES (?, ?, ?, ?, ?)",
		threadID, role, body, draft, now(),
	)
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return s.GetComment(id)
}

func (s *Store) GetComment(id int64) (*Comment, error) {
	var c Comment
	var created string
	var sub sql.NullInt64
	err := s.q.QueryRow("SELECT id, thread_id, author_role, body, draft, submission_id, created_at FROM comments WHERE id = ?", id).
		Scan(&c.ID, &c.ThreadID, &c.AuthorRole, &c.Body, &c.Draft, &sub, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if sub.Valid {
		c.SubmissionID = &sub.Int64
	}
	c.CreatedAt = parseTime(created)
	return &c, nil
}

// UpdateDraftComment edits a draft's body; submitted comments are immutable.
func (s *Store) UpdateDraftComment(id int64, body string) error {
	c, err := s.GetComment(id)
	if err != nil {
		return err
	}
	if !c.Draft {
		return ErrNotDraft
	}
	_, err = s.q.Exec("UPDATE comments SET body = ? WHERE id = ?", body, id)
	return err
}

// DeleteDraftComment removes a draft. If the thread has no comments
// left, the thread and its anchors are removed too.
func (s *Store) DeleteDraftComment(id int64) error {
	c, err := s.GetComment(id)
	if err != nil {
		return err
	}
	if !c.Draft {
		return ErrNotDraft
	}
	if _, err := s.q.Exec("DELETE FROM comments WHERE id = ?", id); err != nil {
		return err
	}
	var remaining int
	if err := s.q.QueryRow("SELECT COUNT(*) FROM comments WHERE thread_id = ?", c.ThreadID).Scan(&remaining); err != nil {
		return err
	}
	if remaining == 0 {
		if _, err := s.q.Exec("DELETE FROM thread_anchors WHERE thread_id = ?", c.ThreadID); err != nil {
			return err
		}
		if _, err := s.q.Exec("DELETE FROM threads WHERE id = ?", c.ThreadID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) SetThreadResolved(id int64, resolved bool) error {
	res, err := s.q.Exec("UPDATE threads SET resolved = ? WHERE id = ?", resolved, id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// CommentsForThread returns a thread's comments in creation order.
// Drafts are included only when includeDrafts is set: draft comments
// are invisible outside the reviewer's own UI (R5).
func (s *Store) CommentsForThread(threadID int64, includeDrafts bool) ([]*Comment, error) {
	q := "SELECT id, thread_id, author_role, body, draft, submission_id, created_at FROM comments WHERE thread_id = ?"
	if !includeDrafts {
		q += " AND draft = 0"
	}
	rows, err := s.q.Query(q+" ORDER BY id", threadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Comment
	for rows.Next() {
		var c Comment
		var created string
		var sub sql.NullInt64
		if err := rows.Scan(&c.ID, &c.ThreadID, &c.AuthorRole, &c.Body, &c.Draft, &sub, &created); err != nil {
			return nil, err
		}
		if sub.Valid {
			c.SubmissionID = &sub.Int64
		}
		c.CreatedAt = parseTime(created)
		out = append(out, &c)
	}
	return out, rows.Err()
}

// ThreadsForReview returns threads that have at least one visible
// comment. Without includeDrafts, threads whose comments are all
// drafts are omitted entirely (R5: invisible until submitted).
func (s *Store) ThreadsForReview(reviewID int64, includeDrafts bool) ([]*Thread, error) {
	q := `SELECT DISTINCT t.id, t.review_id, t.origin_round_id, t.resolved, t.created_at
	      FROM threads t JOIN comments c ON c.thread_id = t.id`
	if !includeDrafts {
		q += " AND c.draft = 0"
	}
	q += " WHERE t.review_id = ? ORDER BY t.id"
	rows, err := s.q.Query(q, reviewID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Thread
	for rows.Next() {
		var t Thread
		var created string
		if err := rows.Scan(&t.ID, &t.ReviewID, &t.OriginRoundID, &t.Resolved, &created); err != nil {
			return nil, err
		}
		t.CreatedAt = parseTime(created)
		out = append(out, &t)
	}
	return out, rows.Err()
}

// --- Submissions ---

// Submit records a submission and promotes every reviewer draft in the
// review to a submitted comment tied to it. Call inside WithTx along
// with the event append so delivery is atomic (AE3).
func (s *Store) Submit(reviewID, roundID int64, verdict, summary string) (*Submission, error) {
	res, err := s.q.Exec(
		"INSERT INTO submissions (review_id, round_id, verdict, summary, created_at) VALUES (?, ?, ?, ?, ?)",
		reviewID, roundID, verdict, summary, now(),
	)
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	if _, err := s.q.Exec(
		`UPDATE comments SET draft = 0, submission_id = ?
		 WHERE draft = 1 AND author_role = ? AND thread_id IN (SELECT id FROM threads WHERE review_id = ?)`,
		id, RoleReviewer, reviewID,
	); err != nil {
		return nil, err
	}
	return s.GetSubmission(id)
}

func (s *Store) GetSubmission(id int64) (*Submission, error) {
	var sub Submission
	var created string
	err := s.q.QueryRow("SELECT id, review_id, round_id, verdict, summary, created_at FROM submissions WHERE id = ?", id).
		Scan(&sub.ID, &sub.ReviewID, &sub.RoundID, &sub.Verdict, &sub.Summary, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	sub.CreatedAt = parseTime(created)
	return &sub, nil
}

func (s *Store) SubmissionsForReview(reviewID int64) ([]*Submission, error) {
	rows, err := s.q.Query("SELECT id, review_id, round_id, verdict, summary, created_at FROM submissions WHERE review_id = ? ORDER BY id", reviewID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Submission
	for rows.Next() {
		var sub Submission
		var created string
		if err := rows.Scan(&sub.ID, &sub.ReviewID, &sub.RoundID, &sub.Verdict, &sub.Summary, &created); err != nil {
			return nil, err
		}
		sub.CreatedAt = parseTime(created)
		out = append(out, &sub)
	}
	return out, rows.Err()
}

// --- Events (KTD6) ---

// AppendEvent appends to the monotonic event log and returns the
// stored event with its cursor id.
func (s *Store) AppendEvent(reviewID int64, eventType string, payload any) (*Event, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	res, err := s.q.Exec(
		"INSERT INTO events (review_id, type, payload, created_at) VALUES (?, ?, ?, ?)",
		reviewID, eventType, string(data), now(),
	)
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	var e Event
	var created, payloadStr string
	if err := s.q.QueryRow("SELECT id, review_id, type, payload, created_at FROM events WHERE id = ?", id).
		Scan(&e.ID, &e.ReviewID, &e.Type, &payloadStr, &created); err != nil {
		return nil, err
	}
	e.Payload = json.RawMessage(payloadStr)
	e.CreatedAt = parseTime(created)
	return &e, nil
}

// EventsSince returns a review's events with id > since, oldest first.
func (s *Store) EventsSince(reviewID, since int64) ([]*Event, error) {
	rows, err := s.q.Query(
		"SELECT id, review_id, type, payload, created_at FROM events WHERE review_id = ? AND id > ? ORDER BY id",
		reviewID, since,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Event
	for rows.Next() {
		var e Event
		var created, payload string
		if err := rows.Scan(&e.ID, &e.ReviewID, &e.Type, &payload, &created); err != nil {
			return nil, err
		}
		e.Payload = json.RawMessage(payload)
		e.CreatedAt = parseTime(created)
		out = append(out, &e)
	}
	return out, rows.Err()
}
