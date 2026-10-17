import { connect } from '@mono/core';

connect(process.argv[2] ?? 'redis://localhost').query('RETURN 1');
