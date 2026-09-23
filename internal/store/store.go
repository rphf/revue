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
	"sort"
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
}

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

const threadCols = "id, path, old_path, status, side, start_line, line, hunk_hash, hunk_start, COALESCE(old_blob, ''), COALESCE(new_blob, ''), resolved, created_at"

type rowScanner interface {
	Scan(dest ...any) error
}

func scanThread(row rowScanner) (*Thread, error) {
	var t Thread
	var start sql.NullInt64
	var created string
	err := row.Scan(&t.ID, &t.Path, &t.OldPath, &t.Status, &t.Side, &start, &t.Line, &t.HunkHash, &t.HunkStart, &t.OldBlob, &t.NewBlob, &t.Resolved, &created)
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
	res, err := s.q.Exec(
		`INSERT INTO threads (path, old_path, status, side, start_line, line, hunk_hash, hunk_start, old_blob, new_blob, resolved, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
		nt.Path, nt.OldPath, nt.Status, nt.Side, start, nt.Line, nt.HunkHash, nt.HunkStart, oldHash, newHash, now(),
	)
	if err != nil {
		return nil, nil, err
	}
	threadID, err := res.LastInsertId()
	if err != nil {
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
	return scanThread(s.q.QueryRow("SELECT "+threadCols+" FROM threads WHERE id = ?", id))
}

// ListThreads returns threads that have at least one visible comment,
// oldest first. Without includeDrafts, threads whose comments are all
// drafts are omitted entirely: drafts are invisible until sent.
func (s *Store) ListThreads(includeDrafts bool) ([]*Thread, error) {
	visible := "SELECT thread_id FROM comments"
	if !includeDrafts {
		visible += " WHERE draft = 0"
	}
	rows, err := s.q.Query("SELECT " + threadCols + " FROM threads WHERE id IN (" + visible + ") ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []*Thread
	for rows.Next() {
		t, err := scanThread(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
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
	rows, err := s.q.Query(q+" ORDER BY id", threadID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []*Comment
	for rows.Next() {
		c, err := scanComment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
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
	res, err := s.q.Exec("INSERT INTO sends (note, created_at) VALUES (?, ?)", note, now())
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	if _, err := s.q.Exec(
		"UPDATE comments SET draft = 0, send_id = ? WHERE draft = 1 AND author_role = ?",
		id, RoleReviewer,
	); err != nil {
		return nil, err
	}
	return s.GetSend(id)
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
	rows, err := s.q.Query("SELECT " + sendCols + " FROM sends ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	sends := []*Send{}
	for rows.Next() {
		sd, err := scanSend(rows)
		if err != nil {
			return nil, err
		}
		sends = append(sends, sd)
	}
	return sends, rows.Err()
}

// --- Events ---

// AppendEvent appends to the monotonic event log and returns the
// stored event with its cursor id.
func (s *Store) AppendEvent(eventType string, payload any) (*Event, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	res, err := s.q.Exec(
		"INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)",
		eventType, string(data), now(),
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
	if err := s.q.QueryRow("SELECT id, type, payload, created_at FROM events WHERE id = ?", id).
		Scan(&e.ID, &e.Type, &payloadStr, &created); err != nil {
		return nil, err
	}
	e.Payload = json.RawMessage(payloadStr)
	e.CreatedAt = parseTime(created)
	return &e, nil
}

// EventsSince returns the events with id > since, oldest first.
func (s *Store) EventsSince(since int64) ([]*Event, error) {
	rows, err := s.q.Query("SELECT id, type, payload, created_at FROM events WHERE id > ? ORDER BY id", since)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []*Event
	for rows.Next() {
		var e Event
		var created, payload string
		if err := rows.Scan(&e.ID, &e.Type, &payload, &created); err != nil {
			return nil, err
		}
		e.Payload = json.RawMessage(payload)
		e.CreatedAt = parseTime(created)
		out = append(out, &e)
	}
	return out, rows.Err()
}
