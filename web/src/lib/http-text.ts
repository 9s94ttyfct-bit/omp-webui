/**
 * What to say of a failed response that carried no message of the server's own (a proxy's or Cloudflare's error page): the
 * status text when there is one, else the status. Over HTTP/2 and HTTP/3, which a page reached through the tunnel is served
 * by, `Response.statusText` is always empty, and an error that says nothing is of no use to anyone.
 */
export const httpText = (res: Response): string => res.statusText || `HTTP ${res.status}`;
