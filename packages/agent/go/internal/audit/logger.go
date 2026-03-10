package audit

import (
	"encoding/json"
	"os"
	"sync"
	"time"
)

type Entry struct {
	Timestamp           string            `json:"ts"`
	Client              string            `json:"client"`
	Action              string            `json:"action"`
	Details             map[string]any    `json:"details,omitempty"`
	PolicyModifications []string          `json:"policy_modifications,omitempty"`
	Result              string            `json:"result"`
	Error               string            `json:"error,omitempty"`
}

type Logger struct {
	mu   sync.Mutex
	file *os.File
}

func NewLogger(path string) (*Logger, error) {
	if path == "" {
		return &Logger{}, nil
	}

	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return nil, err
	}

	return &Logger{file: f}, nil
}

func (l *Logger) Log(entry Entry) {
	if l.file == nil {
		return
	}

	entry.Timestamp = time.Now().UTC().Format(time.RFC3339)

	l.mu.Lock()
	defer l.mu.Unlock()

	data, err := json.Marshal(entry)
	if err != nil {
		return
	}
	data = append(data, '\n')
	l.file.Write(data)
}

func (l *Logger) Close() {
	if l.file != nil {
		l.file.Close()
	}
}
