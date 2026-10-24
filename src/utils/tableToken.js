// QR code link: ?restaurant=demo&t=<32 hex chars>. The server validates the token;
// this only rejects obvious garbage so it never reaches the request.
const TOKEN_PATTERN = /^[0-9a-f]{32}$/

export function parseTableToken(search) {
  const value = new URLSearchParams(search).get('t') ?? ''
  return TOKEN_PATTERN.test(value) ? value : ''
}
