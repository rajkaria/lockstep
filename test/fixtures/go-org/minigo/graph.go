package minigo

type QueryOption func(*queryConfig)

type queryConfig struct{ timeout int }

type Graph struct {
	client *Client
	Name   string
}

func (g *Graph) Query(q string, params map[string]interface{}, opts ...QueryOption) (*Result, error) {
	return g.run(q)
}

func (g *Graph) ROQuery(q string, params map[string]interface{}) (*Result, error) {
	return g.Query(q, params)
}

func (g *Graph) run(q string) (*Result, error) {
	return &Result{}, nil
}

func WithTimeout(ms int) QueryOption {
	return func(c *queryConfig) { c.timeout = ms }
}
