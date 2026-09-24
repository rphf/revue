package server

import (
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"
)

// DefaultArchiveRetention is how long an archived thread stays before it
// is deleted. The branch history lives on archived threads, so it is
// long.
const DefaultArchiveRetention = 90 * 24 * time.Hour

// maintenanceInterval is how often a running server prunes.
const maintenanceInterval = 24 * time.Hour

// vacuumMinBytes keeps small databases from being rewritten for nothing.
const vacuumMinBytes = 1 << 20

// ParseRetention reads a retention period: a Go duration, a number of
// days such as "90d", or "0" to keep archived threads forever.
func ParseRetention(v string) (time.Duration, error) {
	v = strings.TrimSpace(v)
	if days, ok := strings.CutSuffix(v, "d"); ok {
		n, err := strconv.Atoi(days)
		if err != nil || n < 0 {
			return 0, fmt.Errorf("invalid retention %q", v)
		}
		return time.Duration(n) * 24 * time.Hour, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d < 0 {
		return 0, fmt.Errorf("invalid retention %q: use a duration such as 2160h, a number of days such as 90d, or 0", v)
	}
	return d, nil
}

// prune deletes what retention allows: archived threads past it, then
// the snapshots and events nothing needs any more.
func (s *Server) prune(retention time.Duration) error {
	if retention > 0 {
		cutoff := time.Now().Add(-retention)
		if _, err := s.store.PruneArchived(cutoff); err != nil {
			return err
		}
		if _, err := s.store.PruneEvents(cutoff); err != nil {
			return err
		}
	}
	_, err := s.store.PruneBlobs()
	return err
}

// vacuumIfFragmented rewrites the database when most of it is free
// pages, which dropped tables and pruning leave behind.
func (s *Server) vacuumIfFragmented() error {
	free, total, pageSize, err := s.store.Fragmentation()
	if err != nil {
		return err
	}
	if total*pageSize < vacuumMinBytes || free*2 <= total {
		return nil
	}
	return s.store.Vacuum()
}

// maintain runs once at start, before serving, then every
// maintenanceInterval until the server closes.
func (s *Server) maintain(retention time.Duration) {
	if err := s.prune(retention); err != nil {
		log.Printf("revue: prune: %v", err)
	}
	if err := s.vacuumIfFragmented(); err != nil {
		log.Printf("revue: vacuum: %v", err)
	}
}

func (s *Server) maintenanceLoop(retention time.Duration) {
	tick := time.NewTicker(maintenanceInterval)
	defer tick.Stop()
	for {
		select {
		case <-s.closing:
			return
		case <-tick.C:
			if err := s.prune(retention); err != nil {
				log.Printf("revue: prune: %v", err)
			}
		}
	}
}
