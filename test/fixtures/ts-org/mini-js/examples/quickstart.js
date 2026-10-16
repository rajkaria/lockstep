const { Client } = require('@acme/minigraph');

const db = new Client({ url: 'redis://localhost' });
db.selectGraph('social').roQuery('MATCH (n) RETURN n');
