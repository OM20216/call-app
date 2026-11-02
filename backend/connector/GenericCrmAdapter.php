<?php
/**
 * GenericCrmAdapter
 * ─────────────────────────────────────────────────────────────
 * A single adapter that can talk to ANY CRM or custom API.
 * Behaviour is driven entirely by the config_json stored in the
 * crm_connections table — no CRM-specific code lives here.
 *
 * ── config_json structure ────────────────────────────────────
 * {
 *   "auth": {
 *     "type": "bearer" | "api_key" | "basic" | "custom_header",
 *
 *     -- bearer / api_key:
 *     "token": "your-api-token-here",
 *
 *     -- basic auth:
 *     "username": "user",
 *     "password": "pass",
 *
 *     -- custom_header (any header name/value you need):
 *     "header_name":  "X-My-Auth",
 *     "header_value": "secret"
 *   },
 *
 *   "endpoints": {
 *     "base_url":      "https://yourcrm.example.com/api",
 *
 *     -- {id} is replaced with the candidate ID at runtime:
 *     "get_candidate": "/candidates/{id}",
 *
 *     -- {query} is replaced with the search term:
 *     "search":        "/candidates?search={query}",
 *
 *     -- optional: write call activity back to the CRM
 *     -- {id} = candidate ID; body sent as JSON POST
 *     "log_call":      "/candidates/{id}/activities"
 *   },
 *
 *   "field_map": {
 *     -- Keys are fixed app names; values are the JSON field
 *     -- paths returned by YOUR CRM.
 *     -- Use dot-notation for nested fields: "contact.phone"
 *     "id":       "id",
 *     "name":     "full_name",
 *     "phone":    "mobile_number",
 *     "email":    "email_address",   -- optional
 *     "position": "job_title"        -- optional
 *   },
 *
 *   -- Optional: path inside the response to the record array.
 *   -- E.g. if search returns {"results":[...]} use "results".
 *   -- Leave blank if the endpoint returns the array directly.
 *   "response_list_key": "results",
 *
 *   -- Optional: path to a single record.
 *   -- E.g. if get_candidate returns {"candidate":{...}} use "candidate".
 *   -- Leave blank if the endpoint returns the object directly.
 *   "response_record_key": "candidate"
 * }
 * ─────────────────────────────────────────────────────────────
 */

declare(strict_types=1);

class GenericCrmAdapter
{
    private array $cfg;   // full decoded config_json

    public function __construct(array $config)
    {
        $this->cfg = $config;
    }

    // ─────────────────────────────────────────────────────────
    // PUBLIC API
    // ─────────────────────────────────────────────────────────

    /**
     * Test the connection by fetching the search endpoint with
     * an empty query. Returns true on HTTP 2xx.
     */
    public function testConnection(): bool
    {
        try {
            $url = $this->buildUrl('search', ['query' => '']);
            $res = $this->request('GET', $url);
            return $res['status'] < 300;
        } catch (\Throwable $e) {
            throw new \RuntimeException('Connection test failed: ' . $e->getMessage());
        }
    }

    /**
     * Fetch a single candidate by their CRM ID.
     * Returns a normalized array: [id, name, phone, email, position]
     */
    public function getCandidate(string $candidateId): array
    {
        $url = $this->buildUrl('get_candidate', ['id' => $candidateId]);
        $res = $this->request('GET', $url);

        $raw = $this->unwrapRecord($res['body']);

        if (empty($raw)) {
            throw new \RuntimeException('Candidate not found.', 404);
        }

        return $this->normalize($raw);
    }

    /**
     * Search candidates by a free-text query.
     * Returns array of normalized candidate arrays.
     */
    public function searchCandidates(string $query): array
    {
        $url = $this->buildUrl('search', ['query' => urlencode($query)]);
        $res = $this->request('GET', $url);

        $list = $this->unwrapList($res['body']);
        return array_map([$this, 'normalize'], $list);
    }

    /**
     * Write a call-activity back to the CRM (optional).
     * Only runs if "log_call" endpoint is configured.
     * Returns true if written, false if not configured.
     */
    public function logCallToCrm(string $candidateId, string $attemptedAt): bool
    {
        $endpoint = $this->cfg['endpoints']['log_call'] ?? '';
        if ($endpoint === '') return false;

        $url  = $this->buildUrl('log_call', ['id' => $candidateId]);
        $body = [
            'type'        => 'call_attempt',
            'description' => 'Call attempt initiated from HR Calling App',
            'timestamp'   => $attemptedAt,
        ];

        $this->request('POST', $url, $body);
        return true;
    }

    /**
     * Write the full call outcome back to the CRM (HRMS call-update endpoint).
     * Expects an array shaped like the HRMS call-result payload.
     */
    public function logCallOutcome(string $candidateId, array $call): bool
    {
        $endpointKey = 'call_update';
        $endpoint = $this->cfg['endpoints'][$endpointKey] ?? '';
        if ($endpoint === '') {
            $endpointKey = 'log_call';
            $endpoint = $this->cfg['endpoints'][$endpointKey] ?? '';
        }
        if ($endpoint === '') {
            return false;
        }

        $url = $this->buildUrl($endpointKey, ['id' => $candidateId]);
        $this->request('POST', $url, $call);
        return true;
    }

    // ─────────────────────────────────────────────────────────
    // PRIVATE HELPERS
    // ─────────────────────────────────────────────────────────

    /** Build a full URL by substituting {placeholders} */
    private function buildUrl(string $endpointKey, array $vars = []): string
    {
        $base     = rtrim($this->cfg['endpoints']['base_url'] ?? '', '/');
        $path     = $this->cfg['endpoints'][$endpointKey]    ?? '';

        if ($path === '') {
            throw new \RuntimeException("Endpoint '$endpointKey' is not configured.");
        }

        foreach ($vars as $k => $v) {
            $path = str_replace('{' . $k . '}', $v, $path);
        }

        // If path is already a full URL, use it directly
        if (str_starts_with($path, 'http')) return $path;

        return $base . '/' . ltrim($path, '/');
    }

    /** Perform an HTTP request with the configured auth method */
    private function request(string $method, string $url, ?array $body = null): array
    {
        $headers = $this->buildAuthHeaders();

        if ($body !== null) {
            $headers[] = 'Content-Type: application/json';
        }

        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL            => $url,
            CURLOPT_CUSTOMREQUEST  => strtoupper($method),
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 15,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_FOLLOWLOCATION => true,
        ]);

        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
        }

        $raw    = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err    = curl_error($ch);
        curl_close($ch);

        if ($err) {
            throw new \RuntimeException("Network error: $err");
        }

        $decoded = json_decode($raw, true);
        $parsed  = ($decoded !== null) ? $decoded : $raw;

        if ($status >= 400) {
            $msg = is_array($parsed)
                ? ($parsed['error'] ?? $parsed['message'] ?? "HTTP $status")
                : "HTTP $status";
            $ex = new \RuntimeException($msg);
            // Attach HTTP status so callers can distinguish 404 vs 500
            throw new class($msg, $status) extends \RuntimeException {};
        }

        return ['status' => $status, 'body' => $parsed];
    }

    /** Build HTTP headers based on auth.type */
    private function buildAuthHeaders(): array
    {
        $auth    = $this->cfg['auth'] ?? [];
        $type    = $auth['type'] ?? 'none';
        $headers = ['Accept: application/json'];

        switch ($type) {
            case 'bearer':
                $headers[] = 'Authorization: Bearer ' . ($auth['token'] ?? '');
                break;

            case 'api_key':
                // API key in Authorization header (common pattern)
                $headers[] = 'Authorization: ' . ($auth['token'] ?? '');
                break;

            case 'basic':
                $encoded   = base64_encode(($auth['username'] ?? '') . ':' . ($auth['password'] ?? ''));
                $headers[] = "Authorization: Basic $encoded";
                break;

            case 'custom_header':
                $headers[] = ($auth['header_name'] ?? 'X-Api-Key') . ': ' . ($auth['header_value'] ?? '');
                break;

            case 'none':
            default:
                break;
        }

        return $headers;
    }

    /**
     * Extract a single record from the response body.
     * Supports optional response_record_key and dot-notation.
     */
    private function unwrapRecord(mixed $body): array
    {
        $key = $this->cfg['response_record_key'] ?? '';
        if ($key !== '' && is_array($body)) {
            $body = $this->dotGet($body, $key);
        }
        return is_array($body) ? $body : [];
    }

    /**
     * Extract a list of records from the response body.
     * Supports optional response_list_key.
     */
    private function unwrapList(mixed $body): array
    {
        $key = $this->cfg['response_list_key'] ?? '';
        if ($key !== '' && is_array($body)) {
            $body = $this->dotGet($body, $key);
        }
        return is_array($body) ? array_values($body) : [];
    }

    /**
     * Normalize a raw CRM record to a standard app array using field_map.
     * Supports dot-notation in field_map values (e.g. "contact.phone").
     */
    private function normalize(array $raw): array
    {
        $map = array_merge([
            'id'       => 'id',
            'name'     => 'name',
            'phone'    => 'phone',
            'email'    => 'email',
            'position' => 'position',
        ], $this->cfg['field_map'] ?? []);

        return [
            'crm_id'   => (string) $this->dotGet($raw, $map['id']       ?? 'id',       ''),
            'name'     => (string) $this->dotGet($raw, $map['name']     ?? 'name',     'Unknown'),
            'phone'    => (string) $this->dotGet($raw, $map['phone']    ?? 'phone',    ''),
            'email'    => (string) $this->dotGet($raw, $map['email']    ?? 'email',    ''),
            'position' => (string) $this->dotGet($raw, $map['position'] ?? 'position', ''),
        ];
    }

    /**
     * Read a value from a nested array using dot notation.
     * e.g. dotGet($arr, 'contact.phone') reads $arr['contact']['phone']
     */
    private function dotGet(array $arr, string $path, mixed $default = null): mixed
    {
        $parts = explode('.', $path);
        $cur   = $arr;
        foreach ($parts as $part) {
            if (!is_array($cur) || !array_key_exists($part, $cur)) return $default;
            $cur = $cur[$part];
        }
        return $cur;
    }
}
