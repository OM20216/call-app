/*
 * Microsoft Graph address book (optional).
 * Token/people caches are per-isolate, which is enough — Workers recycle often.
 */

function graphConfig(env) {
  const tenantId = env.GRAPH_TENANT_ID || '';
  const clientId = env.GRAPH_CLIENT_ID || '';
  const clientSecret = env.GRAPH_CLIENT_SECRET || '';
  return { tenantId, clientId, clientSecret, enabled: Boolean(tenantId && clientId && clientSecret) };
}

let tokenCache = { value: null, expiresAt: 0 };
let peopleCache = { value: null, expiresAt: 0 };

async function getAppToken(env) {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  const cfg = graphConfig(env);

  const url = `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const res = await fetch(url, { method: 'POST', body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.error || `Graph token failed (HTTP ${res.status})`);
  }

  tokenCache = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(0, (data.expires_in || 3600) - 120) * 1000,
  };
  return tokenCache.value;
}

function normalizeUser(u) {
  const phone = String(
    u.mobilePhone || (Array.isArray(u.businessPhones) && u.businessPhones[0]) || '',
  ).replace(/[^\d+]/g, '');
  return {
    graphId: u.id,
    name: u.displayName || '',
    phone,
    email: u.mail || u.userPrincipalName || '',
    jobTitle: [u.jobTitle, u.department].filter(Boolean).join(' · '),
  };
}

export async function loadPeople(env) {
  if (!graphConfig(env).enabled) return demoPeople();
  if (peopleCache.value && Date.now() < peopleCache.expiresAt) return peopleCache.value;

  const token = await getAppToken(env);
  let url =
    'https://graph.microsoft.com/v1.0/users' +
    '?$select=id,displayName,mail,userPrincipalName,mobilePhone,businessPhones,jobTitle,department' +
    '&$top=200';

  const people = [];
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error((data.error && data.error.message) || `Graph request failed (HTTP ${res.status})`);
    }
    for (const u of data.value || []) {
      const person = normalizeUser(u);
      if (person.name) people.push(person);
    }
    url = data['@odata.nextLink'] || null;
  }

  people.sort((a, b) => a.name.localeCompare(b.name));
  peopleCache = { value: people, expiresAt: Date.now() + 5 * 60 * 1000 };
  return people;
}

export function searchPeople(people, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return people;
  return people.filter((p) =>
    `${p.name} ${p.email} ${p.phone} ${p.jobTitle}`.toLowerCase().includes(q),
  );
}

function demoPeople() {
  return [
    { graphId: 'demo-1', name: 'Alice Johnson', phone: '+15550100', email: 'alice@contoso.com', jobTitle: 'Product Designer' },
    { graphId: 'demo-2', name: 'Brian Lee', phone: '+15550101', email: 'brian@contoso.com', jobTitle: 'Backend Engineer' },
    { graphId: 'demo-3', name: 'Carmen Diaz', phone: '+15550102', email: 'carmen@contoso.com', jobTitle: 'Recruiter' },
    { graphId: 'demo-4', name: 'David Okafor', phone: '+15550103', email: 'david@contoso.com', jobTitle: 'QA Engineer' },
    { graphId: 'demo-5', name: 'Elena Petrova', phone: '+15550104', email: 'elena@contoso.com', jobTitle: 'Engineering Manager' },
    { graphId: 'demo-6', name: 'Farid Haddad', phone: '+15550105', email: 'farid@contoso.com', jobTitle: 'Data Analyst' },
  ];
}
