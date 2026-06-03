<?php

declare(strict_types=1);

namespace FounderOS;

/**
 * FounderOS analytics SDK — PHP (server-side).
 *
 * Buffers product events and flushes them in batches to the track-event edge
 * function. Authenticates with an `fos_` API key (Integrations → API Keys); the
 * workspace is resolved from the key, so only the project id is required.
 *
 * Because PHP is request-scoped, there is no background thread: events are
 * flushed when the buffer fills, when you call flush(), or automatically on
 * script shutdown (a shutdown handler is registered in the constructor).
 *
 * Usage:
 *   $fos = new \FounderOS\FounderOS([
 *       'host'       => 'https://xxxx.supabase.co',
 *       'project_id' => '<project-uuid>',
 *       'api_key'    => 'fos_...',
 *   ]);
 *   $fos->track('signup', 'user@example.com', ['plan' => 'pro']);
 *   $fos->flush();
 *
 * Requires the cURL extension (ships with most PHP installs).
 */
final class FounderOS
{
    private string $host;
    private string $projectId;
    private ?string $apiKey;
    private ?string $workspaceId;
    private ?string $anonKey;
    private int $batchSize;
    private bool $debug;
    private ?string $distinctId = null;

    /** @var array<int, array<string, mixed>> */
    private array $queue = [];

    /** @param array<string, mixed> $config */
    public function __construct(array $config)
    {
        if (empty($config['host']) || empty($config['project_id'])) {
            throw new \InvalidArgumentException('FounderOS: host and project_id are required');
        }
        $this->host        = rtrim((string) $config['host'], '/');
        $this->projectId   = (string) $config['project_id'];
        $this->apiKey      = isset($config['api_key']) ? (string) $config['api_key'] : null;
        $this->workspaceId = isset($config['workspace_id']) ? (string) $config['workspace_id'] : null;
        $this->anonKey     = isset($config['anon_key']) ? (string) $config['anon_key'] : null;
        $this->batchSize   = (int) ($config['batch_size'] ?? 20);
        $this->debug       = (bool) ($config['debug'] ?? false);

        if ($this->apiKey === null && ($this->workspaceId === null || $this->anonKey === null)) {
            throw new \InvalidArgumentException(
                'FounderOS: provide api_key (server) or workspace_id + anon_key'
            );
        }

        // Flush whatever is left when the request ends.
        register_shutdown_function([$this, 'flush']);
    }

    /** Associate subsequent events with a user. */
    public function identify(string $distinctId, ?array $properties = null): void
    {
        $this->distinctId = $distinctId;
        if ($properties !== null) {
            $this->track('$identify', $distinctId, $properties);
        }
    }

    /**
     * Queue an event. Sent on the next flush (or immediately when the buffer
     * reaches batch_size).
     *
     * @param array<string, mixed>|null $properties
     */
    public function track(
        string $eventName,
        ?string $distinctId = null,
        ?array $properties = null,
        ?string $occurredAt = null
    ): void {
        $this->queue[] = [
            'event_name'  => $eventName,
            'distinct_id' => $distinctId ?? $this->distinctId,
            'properties'  => $properties ?? new \stdClass(),
            'occurred_at' => $occurredAt ?? gmdate('Y-m-d\TH:i:s\Z'),
        ];
        if (count($this->queue) >= $this->batchSize) {
            $this->flush();
        }
    }

    /** Send all queued events now. */
    public function flush(): void
    {
        if (count($this->queue) === 0) {
            return;
        }
        $batch = $this->queue;
        $this->queue = [];
        try {
            $this->post('track-event', [
                'project_id'   => $this->projectId,
                'workspace_id' => $this->workspaceId,
                'batch'        => $batch,
            ]);
            $this->log('flushed ' . count($batch) . ' events');
        } catch (\Throwable $e) {
            // Re-queue so events aren't lost within this request.
            $this->queue = array_merge($batch, $this->queue);
            $this->log('flush failed, re-queued: ' . $e->getMessage());
        }
    }

    /** @param array<string, mixed> $body */
    private function post(string $fn, array $body): void
    {
        $headers = ['Content-Type: application/json'];
        if ($this->apiKey !== null) {
            $headers[] = 'Authorization: Bearer ' . $this->apiKey;
        }
        if ($this->anonKey !== null) {
            $headers[] = 'apikey: ' . $this->anonKey;
        }

        $ch = curl_init($this->host . '/functions/v1/' . $fn);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_POSTFIELDS     => json_encode($body, JSON_UNESCAPED_SLASHES),
            CURLOPT_TIMEOUT        => 10,
        ]);
        $resp   = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err    = curl_error($ch);
        curl_close($ch);

        if ($resp === false) {
            throw new \RuntimeException("$fn request failed: $err");
        }
        if ($status < 200 || $status >= 300) {
            throw new \RuntimeException("$fn $status: " . substr((string) $resp, 0, 200));
        }
    }

    private function log(string $msg): void
    {
        if ($this->debug) {
            error_log('[founderos] ' . $msg);
        }
    }
}
