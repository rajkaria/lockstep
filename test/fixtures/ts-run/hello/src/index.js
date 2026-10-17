import { connect } from 'node:net';

export function greet(name) {
  return `Hello, ${name}!`;
}

/** Ask FalkorDB on localhost:6379 for PONG. */
export function ping() {
  return new Promise((resolve, reject) => {
    const socket = connect(6379, 'localhost', () => socket.write('*1\r\n$4\r\nPING\r\n'));
    socket.once('data', (d) => {
      resolve(d.toString().trim());
      socket.end();
    });
    socket.once('error', reject);
  });
}
