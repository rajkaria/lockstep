package minigo

type Result struct {
	rows [][]interface{}
}

func (r *Result) Next() bool { return len(r.rows) > 0 }

func (r *Result) Record() *Record { return &Record{} }

type Record struct{}

func (r *Record) Get(key string) (interface{}, bool) { return nil, false }
