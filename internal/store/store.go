// Package store is the SQLite persistence layer: threads with their
// snapshots, comments, sends, and the event log. It is mechanical;
// domain rules live in the server, except draft visibility, which is
// enforced here because every caller must agree on it.
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
	"slices"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Author roles.
const (
	RoleReviewer = "reviewer"
	RoleAgent    = "agent"
)

// Anchor sides, matching @pierre/diffs DiffLineAnnotation.
const (
	SideAdditions = "additions"
	SideDeletions = "deletions"
)

// File statuses.
const (
	FileAdded    = "added"
	FileModified = "modified"
	FileDeleted  = "deleted"
	FileRenamed  = "renamed"
)

// ErrNotDraft is returned when editing or deleting a comment that has
// already been sent.
var ErrNotDraft = errors.New("comment is not a draft")

// ErrNotFound is returned when a row does not exist.
var ErrNotFound = errors.New("not found")

// ErrNothingToSend is returned by Send when there is no draft and no note.
var ErrNothingToSend = errors.New("nothing to send")

// Thread is a comment thread anchored where its first comment was
// written. The snapshot fields are what later diffs are matched
// against; they never change.
type Thread struct {
	ID        int64     `json:"id"`
	Path      string    `json:"path"`
	OldPath   string    `json:"oldPath,omitempty"`
	Status    string    `json:"status"`
	Side      string    `json:"side"`
	StartLine *int      `json:"startLine,omitempty"`
	Line      int       `json:"line"`
	HunkHash  string    `json:"-"`
	HunkStart int       `json:"-"`
	OldBlob   string    `json:"-"`
	NewBlob   string    `json:"-"`
	Resolved  bool      `json:"resolved"`
	CreatedAt time.Time `json:"createdAt"`
	// Where the thread was written: the branch ("" on a detached HEAD),
	// HEAD, and the diff arguments. All empty for threads from before
	// origins were recorded.
	Branch string   `json:"branch"`
	Head   string   `json:"head"`
	Args   []string `json:"args"`
	// Base is where the branch left the default branch when the thread
	// was written: a tip still there has no work of its own to merge.
	Base string `json:"-"`
	// ArchivedAt is set once the thread leaves the views; ArchivedHead is
	// the HEAD at that moment, the commit its code landed in.
	ArchivedAt   *time.Time `json:"archivedAt,omitempty"`
	ArchivedHead string     `json:"archivedHead,omitempty"`
	// Kept marks a thread brought back by hand: it never lands again.
	Kept bool `json:"-"`
}

// HasOrigin reports whether the thread recorded where it was written.
func (t *Thread) HasOrigin() bool { return t.Head != "" }

// NewThread carries everything CreateThread freezes: the anchor and the
// file's contents on both sides (nil when the side does not exist).
type NewThread struct {
	Path       string
	OldPath    string
	Status     string
	Side       string
	StartLine  *int
	Line       int
	HunkHash   string
	HunkStart  int
	OldContent []byte
	NewContent []byte
	Branch     string
	Head       string
	Base       string
	Args       []string
}

type Comment struct {
	ID         int64     `json:"id"`
	ThreadID   int64     `json:"threadId"`
	AuthorRole string    `json:"authorRole"`
	Body       string    `json:"body"`
	Draft      bool      `json:"draft"`
	SendID     *int64    `json:"sendId,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
}

// Send is one batch of reviewer comments made visible to the agent.
type Send struct {
	ID        int64     `json:"id"`
	Note      string    `json:"note"`
	CreatedAt time.Time `json:"createdAt"`
}

type Event struct {
	ID        int64           `json:"id"`
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
		_ = db.Close()
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
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

func migrate(db *sql.DB) error {
	names, err := fs.Glob(migrationsFS, "migrations/*.sql")
	if err != nil {
		return err
	}
	slices.Sort(names)
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
			_ = tx.Rollback()
			return fmt.Errorf("store: applying %s: %w", name, err)
		}
		// PRAGMA cannot be parameterized; num comes from the
		// filename we just parsed as an int.
		if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", num)); err != nil {
			_ = tx.Rollback()
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

// --- Blobs ---

// BlobHash is the content address used by the blobs table.
func BlobHash(content []byte) string {
	h := sha256.Sum256(content)
	return hex.EncodeToString(h[:])
}

// PutBlob stores content if absent and returns its hash.
func (s *Store) PutBlob(content []byte) (string, error) {
	hash := BlobHash(content)
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

// --- Threads ---

const threadCols = "id, path, old_path, status, side, start_line, line, hunk_hash, hunk_start, COALESCE(old_blob, ''), COALESCE(new_blob, ''), resolved, created_at, branch, head, base, args, archived_at, archived_head, kept"

type rowScanner interface {
	Scan(dest ...any) error
}

// queryAll runs query and scans every row with scan, in order.
func queryAll[T any](q dbtx, scan func(rowScanner) (T, error), query string, args ...any) ([]T, error) {
	rows, err := q.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []T
	for rows.Next() {
		v, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func scanThread(row rowScanner) (*Thread, error) {
	var t Thread
	var start sql.NullInt64
	var created, args string
	var archived sql.NullString
	err := row.Scan(&t.ID, &t.Path, &t.OldPath, &t.Status, &t.Side, &start, &t.Line, &t.HunkHash, &t.HunkStart, &t.OldBlob, &t.NewBlob, &t.Resolved, &created,
		&t.Branch, &t.Head, &t.Base, &args, &archived, &t.ArchivedHead, &t.Kept)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if start.Valid {
		v := int(start.Int64)
		t.StartLine = &v
	}
	t.CreatedAt = parseTime(created)
	if err := json.Unmarshal([]byte(args), &t.Args); err != nil || t.Args == nil {
		t.Args = []string{}
	}
	if archived.Valid {
		at := parseTime(archived.String)
		t.ArchivedAt = &at
	}
	return &t, nil
}

// CreateThread freezes the anchor and the file snapshot and adds the
// first comment. Reviewer comments start as drafts; agent comments are
// never drafts.
func (s *Store) CreateThread(nt NewThread, role, body string, draft bool) (*Thread, *Comment, error) {
	var oldHash, newHash sql.NullString
	if nt.OldContent != nil {
		h, err := s.PutBlob(nt.OldContent)
		if err != nil {
			return nil, nil, err
		}
		oldHash = sql.NullString{String: h, Valid: true}
	}
	if nt.NewContent != nil {
		h, err := s.PutBlob(nt.NewContent)
		if err != nil {
			return nil, nil, err
		}
		newHash = sql.NullString{String: h, Valid: true}
	}
	var start sql.NullInt64
	if nt.StartLine != nil {
		start = sql.NullInt64{Int64: int64(*nt.StartLine), Valid: true}
	}
	args := nt.Args
	if args == nil {
		args = []string{}
	}
	argsJSON, err := json.Marshal(args)
	if err != nil {
		return nil, nil, err
	}
	t, err := scanThread(s.q.QueryRow(
		`INSERT INTO threads (path, old_path, status, side, start_line, line, hunk_hash, hunk_start, old_blob, new_blob, resolved, created_at, branch, head, base, args)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?) RETURNING `+threadCols,
		nt.Path, nt.OldPath, nt.Status, nt.Side, start, nt.Line, nt.HunkHash, nt.HunkStart, oldHash, newHash, now(),
		nt.Branch, nt.Head, nt.Base, string(argsJSON),
	))
	if err != nil {
		return nil, nil, err
	}
	c, err := s.AddComment(t.ID, role, body, draft)
	if err != nil {
		return nil, nil, err
	}
	return t, c, nil
}

func (s *Store) GetThread(id int64) (*Thread, error) {
	return scanThread(s.q.QueryRow("SELECT "+threadCols+" FROM threads WHERE id = ?", id))
}

// ListThreads returns the unarchived threads that have at least one
// visible comment, oldest first. Without includeDrafts, threads whose
// comments are all drafts are omitted entirely: drafts are invisible
// until sent.
func (s *Store) ListThreads(includeDrafts bool) ([]*Thread, error) {
	visible := "SELECT thread_id FROM comments"
	if !includeDrafts {
		visible += " WHERE draft = 0"
	}
	return queryAll(s.q, scanThread, "SELECT "+threadCols+" FROM threads WHERE archived_at IS NULL AND id IN ("+visible+") ORDER BY id")
}

// ListArchivedThreads returns every archived thread, most recently
// archived first.
func (s *Store) ListArchivedThreads() ([]*Thread, error) {
	return queryAll(s.q, scanThread, "SELECT "+threadCols+" FROM threads WHERE archived_at IS NOT NULL ORDER BY julianday(archived_at) DESC, id DESC")
}

// ThreadsWithDrafts returns the ids of threads holding a reviewer draft.
func (s *Store) ThreadsWithDrafts() (map[int64]bool, error) {
	ids, err := queryAll(s.q, func(r rowScanner) (int64, error) {
		var id int64
		return id, r.Scan(&id)
	}, "SELECT DISTINCT thread_id FROM comments WHERE draft = 1")
	out := make(map[int64]bool, len(ids))
	for _, id := range ids {
		out[id] = true
	}
	return out, err
}

// ArchiveThreads archives the listed threads at head and returns the
// ids it archived. Threads already archived, and threads holding a
// draft, are left alone: a draft is the reviewer's unfinished work.
func (s *Store) ArchiveThreads(ids []int64, head string) ([]int64, error) {
	if len(ids) == 0 {
		return []int64{}, nil
	}
	args := []any{now(), head}
	for _, id := range ids {
		args = append(args, id)
	}
	archived, err := queryAll(s.q, func(r rowScanner) (int64, error) {
		var id int64
		return id, r.Scan(&id)
	}, `UPDATE threads SET archived_at = ?, archived_head = ?
		 WHERE id IN (?`+strings.Repeat(", ?", len(ids)-1)+`) AND archived_at IS NULL
		   AND id NOT IN (SELECT thread_id FROM comments WHERE draft = 1)
		 RETURNING id`, args...)
	if err != nil {
		return nil, err
	}
	slices.Sort(archived)
	if archived == nil {
		archived = []int64{}
	}
	return archived, nil
}

// UnarchiveThread brings an archived thread back into the views and
// keeps it there: a thread the reviewer brought back never lands again.
func (s *Store) UnarchiveThread(id int64) error {
	res, err := s.q.Exec("UPDATE threads SET archived_at = NULL, archived_head = '', kept = 1 WHERE id = ?", id)
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

// ThreadsInSend returns the threads with a comment published by the
// given send, oldest first.
func (s *Store) ThreadsInSend(sendID int64) ([]*Thread, error) {
	return queryAll(s.q, scanThread, "SELECT "+threadCols+" FROM threads WHERE id IN (SELECT thread_id FROM comments WHERE send_id = ?) ORDER BY id", sendID)
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

// --- Comments ---

func (s *Store) AddComment(threadID int64, role, body string, draft bool) (*Comment, error) {
	return scanComment(s.q.QueryRow(
		"INSERT INTO comments (thread_id, author_role, body, draft, created_at) VALUES (?, ?, ?, ?, ?) RETURNING "+commentCols,
		threadID, role, body, draft, now(),
	))
}

const commentCols = "id, thread_id, author_role, body, draft, send_id, created_at"

func scanComment(row rowScanner) (*Comment, error) {
	var c Comment
	var created string
	var send sql.NullInt64
	err := row.Scan(&c.ID, &c.ThreadID, &c.AuthorRole, &c.Body, &c.Draft, &send, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if send.Valid {
		c.SendID = &send.Int64
	}
	c.CreatedAt = parseTime(created)
	return &c, nil
}

func (s *Store) GetComment(id int64) (*Comment, error) {
	return scanComment(s.q.QueryRow("SELECT "+commentCols+" FROM comments WHERE id = ?", id))
}

// UpdateDraftComment edits a draft's body; sent comments are immutable.
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
// left, the thread is removed too.
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
		if _, err := s.q.Exec("DELETE FROM threads WHERE id = ?", c.ThreadID); err != nil {
			return err
		}
	}
	return nil
}

// CommentsForThread returns a thread's comments in creation order.
// Drafts are included only when includeDrafts is set.
func (s *Store) CommentsForThread(threadID int64, includeDrafts bool) ([]*Comment, error) {
	q := "SELECT " + commentCols + " FROM comments WHERE thread_id = ?"
	if !includeDrafts {
		q += " AND draft = 0"
	}
	return queryAll(s.q, scanComment, q+" ORDER BY id", threadID)
}

// CommentsForThreads returns the comments of every listed thread, keyed
// by thread id, each in creation order. Drafts are included only when
// includeDrafts is set.
func (s *Store) CommentsForThreads(threadIDs []int64, includeDrafts bool) (map[int64][]*Comment, error) {
	out := make(map[int64][]*Comment, len(threadIDs))
	if len(threadIDs) == 0 {
		return out, nil
	}
	args := make([]any, len(threadIDs))
	for i, id := range threadIDs {
		args[i] = id
	}
	q := "SELECT " + commentCols + " FROM comments WHERE thread_id IN (?" + strings.Repeat(", ?", len(threadIDs)-1) + ")"
	if !includeDrafts {
		q += " AND draft = 0"
	}
	comments, err := queryAll(s.q, scanComment, q+" ORDER BY thread_id, id", args...)
	if err != nil {
		return nil, err
	}
	for _, c := range comments {
		out[c.ThreadID] = append(out[c.ThreadID], c)
	}
	return out, nil
}

// DraftCount is the number of reviewer comments not yet sent.
func (s *Store) DraftCount() (int, error) {
	var n int
	err := s.q.QueryRow("SELECT COUNT(*) FROM comments WHERE draft = 1").Scan(&n)
	return n, err
}

// --- Sends ---

// Send records a send and promotes every reviewer draft to a sent
// comment tied to it. Call inside WithTx along with the event append so
// delivery is atomic. A send with no draft and no note is refused.
func (s *Store) Send(note string) (*Send, error) {
	drafts, err := s.DraftCount()
	if err != nil {
		return nil, err
	}
	if drafts == 0 && strings.TrimSpace(note) == "" {
		return nil, ErrNothingToSend
	}
	sd, err := scanSend(s.q.QueryRow("INSERT INTO sends (note, created_at) VALUES (?, ?) RETURNING "+sendCols, note, now()))
	if err != nil {
		return nil, err
	}
	if _, err := s.q.Exec(
		"UPDATE comments SET draft = 0, send_id = ? WHERE draft = 1 AND author_role = ?",
		sd.ID, RoleReviewer,
	); err != nil {
		return nil, err
	}
	return sd, nil
}

const sendCols = "id, note, created_at"

func scanSend(row rowScanner) (*Send, error) {
	var sd Send
	var created string
	err := row.Scan(&sd.ID, &sd.Note, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	sd.CreatedAt = parseTime(created)
	return &sd, nil
}

func (s *Store) GetSend(id int64) (*Send, error) {
	return scanSend(s.q.QueryRow("SELECT "+sendCols+" FROM sends WHERE id = ?", id))
}

// LastSend returns the most recent send, or nil when there is none.
func (s *Store) LastSend() (*Send, error) {
	sd, err := scanSend(s.q.QueryRow("SELECT " + sendCols + " FROM sends ORDER BY id DESC LIMIT 1"))
	if errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	return sd, err
}

// ListSends returns every send, oldest first.
func (s *Store) ListSends() ([]*Send, error) {
	sends, err := queryAll(s.q, scanSend, "SELECT "+sendCols+" FROM sends ORDER BY id")
	if sends == nil && err == nil {
		sends = []*Send{}
	}
	return sends, err
}

// --- Settings ---

// Setting returns the JSON value stored under key, and whether there is
// one.
func (s *Store) Setting(key string) (string, bool, error) {
	var v string
	err := s.q.QueryRow("SELECT value FROM settings WHERE key = ?", key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return v, err == nil, err
}

// SetSetting stores the JSON value under key.
func (s *Store) SetSetting(key, value string) error {
	_, err := s.q.Exec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value)
	return err
}

// ReadSetting reads one setting from the database at path without
// migrating or writing it, for tools that look at other repositories'
// databases. A database without the setting reports ok false.
func ReadSetting(path, key string) (value string, ok bool, err error) {
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		return "", false, err
	}
	defer func() { _ = db.Close() }()
	err = db.QueryRow("SELECT value FROM settings WHERE key = ?", key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) || (err != nil && strings.Contains(err.Error(), "no such table")) {
		return "", false, nil
	}
	return value, err == nil, err
}

// --- Retention ---

// PruneArchived deletes the threads archived before cutoff, with their
// comments, and returns how many threads went.
func (s *Store) PruneArchived(cutoff time.Time) (int64, error) {
	old := "SELECT id FROM threads WHERE archived_at IS NOT NULL AND julianday(archived_at) < julianday(?)"
	at := cutoff.UTC().Format(time.RFC3339Nano)
	if _, err := s.q.Exec("DELETE FROM comments WHERE thread_id IN ("+old+")", at); err != nil {
		return 0, err
	}
	res, err := s.q.Exec("DELETE FROM threads WHERE id IN ("+old+")", at)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// PruneBlobs deletes the snapshots no thread refers to any more.
func (s *Store) PruneBlobs() (int64, error) {
	res, err := s.q.Exec(`DELETE FROM blobs WHERE hash NOT IN (
		SELECT old_blob FROM threads WHERE old_blob IS NOT NULL
		UNION SELECT new_blob FROM threads WHERE new_blob IS NOT NULL)`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// PruneEvents deletes the events logged before cutoff. Cursors stay
// valid: AUTOINCREMENT never hands out an id again, so an old cursor
// just reads what is left after it.
func (s *Store) PruneEvents(cutoff time.Time) (int64, error) {
	res, err := s.q.Exec("DELETE FROM events WHERE julianday(created_at) < julianday(?)", cutoff.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// Fragmentation reports the free pages, the total pages, and the page
// size of the file.
func (s *Store) Fragmentation() (free, total, pageSize int64, err error) {
	for _, p := range []struct {
		pragma string
		dst    *int64
	}{{"freelist_count", &free}, {"page_count", &total}, {"page_size", &pageSize}} {
		if err := s.q.QueryRow("PRAGMA " + p.pragma).Scan(p.dst); err != nil {
			return 0, 0, 0, err
		}
	}
	return free, total, pageSize, nil
}

// Vacuum rewrites the file without its free pages. It cannot run
// inside a transaction.
func (s *Store) Vacuum() error {
	_, err := s.q.Exec("VACUUM")
	return err
}

// --- Events ---

const eventCols = "id, type, payload, created_at"

func scanEvent(row rowScanner) (*Event, error) {
	var e Event
	var created, payload string
	if err := row.Scan(&e.ID, &e.Type, &payload, &created); err != nil {
		return nil, err
	}
	e.Payload = json.RawMessage(payload)
	e.CreatedAt = parseTime(created)
	return &e, nil
}

// AppendEvent appends to the monotonic event log and returns the
// stored event with its cursor id.
func (s *Store) AppendEvent(eventType string, payload any) (*Event, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return scanEvent(s.q.QueryRow(
		"INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?) RETURNING "+eventCols,
		eventType, string(data), now(),
	))
}

// EventsSince returns the events with id > since, oldest first.
func (s *Store) EventsSince(since int64) ([]*Event, error) {
	return queryAll(s.q, scanEvent, "SELECT "+eventCols+" FROM events WHERE id > ? ORDER BY id", since)
}
