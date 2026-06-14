export const dynamic = 'force-dynamic';

// Sign-out is intentionally NOT auth-gated: an expired/invalid token must still be able to
// log out. HttpOnly cookies can only be cleared server-side, so we expire awsops_token here and
// also break the Cognito hosted-UI session via /logout (logout_uri is pre-registered in
// auth.tf logout_urls as https://{APP_DOMAIN}/). The edge must let this path through public
// (cognito_edge.py.tftpl is_public) — otherwise an expired token traps the user in a 302→Cognito
// loop and they can never reach the signout route to clear the stale cookie.
export async function POST() {
  const domain = process.env.COGNITO_DOMAIN ?? '';
  const clientId = process.env.COGNITO_CLIENT_ID ?? '';
  const appDomain = process.env.APP_DOMAIN ?? '';
  const logoutUrl = domain && clientId && appDomain
    ? `https://${domain}/logout?client_id=${encodeURIComponent(clientId)}&logout_uri=${encodeURIComponent(`https://${appDomain}/`)}`
    : '/';
  return new Response(JSON.stringify({ logoutUrl }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': 'awsops_token=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0',
    },
  });
}
