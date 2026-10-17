package store

type DB struct{ addr string }

func Open(addr string) *DB { return &DB{addr: addr} }

func (d *DB) Close() error { return nil }
