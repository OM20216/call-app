import { config, graphEnabled } from './config.js';

/*
 * Microsoft Graph = the address book only.
 * We pull people (displayName, email, mobile, job title) and let the HR
 * add the ones they want to their own list. The actual phone call is
 * placed by telephony.js, not by Graph.
 */

let tokenCache = { value: null, expiresAt: 0 };
let peopleCache = { value: null, expiresAt: 0 };

async function getAppToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;

  const url = `https://login.microsoftonline.com/${encodeURIComponent(
    config.graph.tenantId,
  )}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    client_id: config.graph.clientId,
    client_secret: config.graph.clientSecret,
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
  const phone = (u.mobilePhone || (Array.isArray(u.businessPhones) && u.businessPhones[0]) || '').replace(
    /[^\d+]/g,
    '',
  );
  return {
    graphId: u.id,
    name: u.displayName || '',
    phone,
    email: u.mail || u.userPrincipalName || '',
    jobTitle: [u.jobTitle, u.department].filter(Boolean).join(' · '),
  };
}

/** Load everyone in the tenant (cached for a few minutes, paginated). */
export async function loadPeople() {
  if (!graphEnabled) return demoPeople();
  if (peopleCache.value && Date.now() < peopleCache.expiresAt) return peopleCache.value;

  const token = await getAppToken();
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

/** Sample data so the app is usable before Azure is configured. */
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
