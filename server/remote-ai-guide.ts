/**
 * The guide the agent reads (`remote_access_guide`) when it helps with remote access: the steps, what each setting
 * means, where in the Cloudflare dashboard the values are, and what the common errors come from. It ships with the app
 * and is the same for everyone: it holds no one's hostname, team or address (the examples are made up).
 */
export const REMOTE_AI_GUIDE = `# Setting up remote access to omp-webui

Remote access lets the person open this app (it runs you, with tools, on their Mac) from another device at
https://<hostname>. A Cloudflare tunnel carries the hostname to this Mac, and Cloudflare Access asks who is
visiting before anything is served. This app checks the Access token again and lets in only the allowed e-mail addresses.

## How you work

- You change things only with the remote_access_* tools. Never use bash, curl, cloudflared or files to do this, never
  read or print ~/.cloudflared (certificate and tunnel credentials are secrets), and never ask for a Cloudflare password,
  API token or any other secret. The dashboard steps below are the person's to do; you tell them where to click.
- Work one step at a time: call remote_access_status, do what its "next" says, call it again. Say in a sentence what you
  are about to do before a tool that changes something; the person may be asked to approve it.
- Never turn on, off or change anything the tools do not offer. "Allow remote access" and "Start with the app" are the
  person's own switches in Settings › Remote access.
- Before starting the tunnel, say who will be able to sign in (the e-mail addresses) and that a signed-in remote page can
  use this app's tools on this Mac. Start only when the person agrees. If an address looks wrong, ask.
- Reply in the language the person writes in.

## The steps

1. **Install cloudflared** (remote_access_install). It uses Homebrew. Without Homebrew, the person installs
   cloudflared themselves (developers.cloudflare.com › Cloudflare One › Connections › Cloudflare Tunnel › Downloads).
2. **Log in to Cloudflare** (remote_access_login). The sign-in link is a one-time link: it is shown to the person in
   Settings › Remote access (and as a notice in this app), never in your tool results. Tell them to open it, sign in and
   pick the domain (zone) the hostname belongs to. The login is done when remote_access_status says cloudflareLogin
   signedIn is true.
3. **Choose the hostname**, e.g. omp.example.com: a name inside a domain that is in that Cloudflare account. Ask for it.
4. **Create the Access application** in the Cloudflare dashboard (the person does this):
   - Zero Trust › Access › Applications (newer dashboards: Access controls › Applications) › Add an application › Self-hosted.
   - Application domain: the hostname from step 3 (no path). One application can also cover several Macs: give it a
     wildcard domain (\`*.example.com\`, a "*" in the subdomain field) and every hostname under it (mac-a.example.com,
     mac-b.example.com) is behind the same application, the same policy and the same AUD tag, so the second Mac needs
     only its hostname and the same team, AUD and e-mails (Settings › Remote access has an export and an import for them).
   - Policy: action Allow, include Emails, and the addresses that may come in. Only these get in.
   - Make sure a login method is enabled (Zero Trust › Settings › Authentication). One-time PIN sends a code to the
     e-mail address and needs no identity provider.
   - Save, then open the application: the **Application Audience (AUD) Tag** is on its Overview page: 64 hexadecimal
     characters.
   - The **team** is the first part of the team domain, <team>.cloudflareaccess.com (Zero Trust › Settings › General).
5. **Save the settings** (remote_access_save) with what the person pasted: hostname, team, aud, emails. Each value is
   validated; if a value is refused, read the message, tell the person what is wrong and ask again. Save only fields you
   were given; fields you leave out stay as they are.
6. **Set up the tunnel** (remote_access_setup): creates the tunnel (once), points the hostname's DNS record at it and
   writes its configuration. Safe to run again.
7. **Start the tunnel** (remote_access_start). This turns remote access on. The state goes starting, then connected.
8. **Check the address** (remote_access_check): the hostname must answer and Cloudflare Access must ask for a sign-in.
   Then ask the person to open https://<hostname> on another device and sign in with an allowed address.

## The settings

- hostname: the public name, lower case, e.g. omp.example.com.
- team: the Cloudflare team, letters, digits and dashes, e.g. my-team.
- aud: the Access application's AUD tag, 64 hexadecimal characters. A wrong AUD makes this app refuse every visitor.
- emails: the allowed addresses, e.g. jdoe@example.com. Compared without regard to case.

## When something fails

- **A step refuses with a message:** the message says what to do; do that, do not retry blindly.
- **"already has a DNS record" (409):** the hostname already has a record in the Cloudflare zone. The person deletes it in
  the dashboard (DNS › Records), or chooses another hostname.
- **"A tunnel named ... already exists" (409):** this Mac does not have that tunnel's credentials. The person deletes the
  tunnel in the dashboard (Zero Trust › Networks › Tunnels) or runs \`cloudflared tunnel delete <name>\`, then setup runs again.
- **"The hostname was changed since the tunnel was set up":** run remote_access_setup again, then start.
- **"You are not logged in to Cloudflare yet":** run the login (step 2).
- **Error 1033 (or HTTP 530):** Cloudflare cannot reach a running tunnel. Start it and wait for "connected". If it is
  connected, the DNS record may point at another tunnel: run remote_access_setup again.
- **Error 1016 (origin DNS):** the hostname's DNS record points at a tunnel that no longer exists. Delete the record in
  the dashboard, then run remote_access_setup again.
- **HTTP 502 or 52x:** the tunnel is up but this app does not answer on its port. Stop the tunnel and start it again.
- **The check says "no-access" (a plain "Forbidden"):** Cloudflare Access is not in front of the hostname. The
  application's domain must be the hostname or a wildcard that covers it (\`*.example.com\`), and it needs an Allow policy.
- **The person signs in to Cloudflare but this app refuses ("Forbidden"):** the saved team or AUD does not match the
  Access application, or their e-mail address is not in the saved list. Compare each with the dashboard.
- **Access says the person is not allowed:** the Access policy lacks their address. Add it in the dashboard (the app's
  Policies) and in the saved e-mails.
- **The sign-in code never arrives (One-time PIN):** the address is not in the Allow policy, or is in spam.
`;
