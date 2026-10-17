export function connect(host: string, timeout = 10): string {
  return `${host}:${timeout}`;
}
