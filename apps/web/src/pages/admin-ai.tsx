// "Connect a model" (docs/admin.md): the first step of the operator console. The operator signs in
// to a subscription they already pay for (ChatGPT, Claude) or enters an API key, then picks the
// model the platform's agents think with. Sign-ins run in llm-cli on the server; nothing secret
// comes back to the browser.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Copy, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api';
import { authClient } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { Section, selectClass } from '@/pages/admin';

type Option = {
  provider: string;
  label: string;
  kind: 'subscription' | 'key';
  models: string[];
};
type Device = { state: 'pending' | 'done' | 'failed'; url?: string; code?: string };
export type Ai = {
  connected: {
    provider: string;
    model: string;
    label: string;
    keyHint: string | null;
    updatedAt: string;
  } | null;
  options: Option[];
  logins: { claude: boolean; codex: boolean; device: Device | null } | null;
};

const KEY = ['admin', 'ai'];
const NOT_FRESH = 'connecting a model needs a recent sign-in: sign in again, then connect';
const HINT: Record<string, string> = {
  codex_cli: 'Sign in with your ChatGPT account. No API key, no extra bill.',
  claude_cli: 'Use your Claude Pro or Max plan through a token from Claude Code.',
};

export function useAi() {
  return useQuery({ queryKey: KEY, queryFn: () => api<Ai>('/api/admin/ai') });
}

/** The first step: shown instead of the console until a model is connected. */
export function ConnectModelStep({ ai, onSkip }: { ai: Ai; onSkip: () => void }) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        <Badge variant="secondary">First step</Badge>
        <h1 className="text-2xl font-semibold text-balance">Connect a model for your agents</h1>
        <p className="text-muted-foreground">
          The agents of this console think with it, starting with the one that plans changes to your
          stack. Sign in with a subscription you already pay for, or use an API key. You can change
          it any time on the Stack page.
        </p>
      </div>
      <ConnectModel ai={ai} />
      <Button variant="link" className="px-0 text-muted-foreground" onClick={onSkip}>
        Skip for now
      </Button>
    </div>
  );
}

/** On the Stack page: the connected model, and the same form to change it. */
export function ModelSection({ ai }: { ai: Ai }) {
  const [open, setOpen] = useState(false);
  const c = ai.connected;
  return (
    <Section
      title="Model"
      description="What the agents think with."
      action={
        c && (
          <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? 'Cancel' : 'Change'}
          </Button>
        )
      }
    >
      {c && !open ? (
        <p className="text-sm">
          {c.label}: <span className="font-medium">{c.model}</span>
          {c.keyHint && <span className="text-muted-foreground"> (key ending {c.keyHint})</span>}
        </p>
      ) : (
        <ConnectModel ai={ai} onDone={() => setOpen(false)} />
      )}
    </Section>
  );
}

function ConnectModel({ ai, onDone }: { ai: Ai; onDone?: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [provider, setProvider] = useState(ai.connected?.provider ?? ai.options[0]?.provider);
  const option = ai.options.find((o) => o.provider === provider);
  const [model, setModel] = useState(ai.connected?.model ?? option?.models[0]);
  const [apiKey, setApiKey] = useState('');
  const [stale, setStale] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: KEY });
  const onError = (e: Error) => (e.message === NOT_FRESH ? setStale(true) : toast.error(e.message));

  const signedIn =
    provider === 'codex_cli'
      ? ai.logins?.codex
      : provider === 'claude_cli'
        ? ai.logins?.claude
        : true;
  const connect = useMutation({
    mutationFn: () =>
      api('/api/admin/ai', {
        method: 'PUT',
        json: { provider, model, ...(option?.kind === 'key' && apiKey && { apiKey }) },
      }),
    onSuccess: async () => {
      setApiKey('');
      toast('Model connected');
      await refresh();
      onDone?.();
    },
    onError,
  });

  if (!ai.options.length) {
    return (
      <Alert>
        <AlertTitle>No model can plan here</AlertTitle>
        <AlertDescription>
          The AI contour of this server lists no model for the console's agents
          (config/ai-models.json).
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <form
      className="space-y-6"
      aria-label="Connect a model"
      onSubmit={(e) => {
        e.preventDefault();
        connect.mutate();
      }}
    >
      <RadioGroup
        value={provider}
        onValueChange={(v) => {
          setProvider(v);
          setModel(ai.options.find((o) => o.provider === v)?.models[0]);
        }}
        className="grid gap-2 sm:grid-cols-2"
        aria-label="How to connect"
      >
        {ai.options.map((o) => (
          <Label
            key={o.provider}
            htmlFor={`ai-${o.provider}`}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal',
              provider === o.provider && 'border-primary bg-accent',
            )}
          >
            <RadioGroupItem id={`ai-${o.provider}`} value={o.provider} className="mt-0.5" />
            <span className="space-y-1">
              <span className="block font-medium">{o.label}</span>
              <span className="block text-sm text-muted-foreground">
                {HINT[o.provider] ?? 'Billed by the vendor per use.'}
              </span>
            </span>
          </Label>
        ))}
      </RadioGroup>

      {option?.kind === 'subscription' && !ai.logins && (
        <Alert>
          <AlertTitle>Subscriptions are not available on this server</AlertTitle>
          <AlertDescription>
            They run in llm-cli, which pnpm run infra installs. Run it again, or use an API key.
          </AlertDescription>
        </Alert>
      )}
      {provider === 'codex_cli' && ai.logins && (
        <ChatGptSignIn signedIn={Boolean(ai.logins.codex)} onError={onError} onDone={refresh} />
      )}
      {provider === 'claude_cli' && ai.logins && (
        <ClaudeSignIn signedIn={Boolean(ai.logins.claude)} onError={onError} onDone={refresh} />
      )}
      {option?.kind === 'key' && (
        <div className="space-y-2">
          <Label htmlFor="ai-key">API key</Label>
          <Input
            id="ai-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              ai.connected?.provider === provider && ai.connected?.keyHint
                ? `Keep the key ending ${ai.connected?.keyHint}`
                : 'Paste the key'
            }
          />
          <p className="text-sm text-muted-foreground">
            Stored encrypted on the server. Only the AI gateway reads it.
          </p>
        </div>
      )}

      {option && (
        <div className="space-y-2">
          <Label htmlFor="ai-model">Model</Label>
          <select
            id="ai-model"
            className={selectClass}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            {option.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      )}

      {stale && (
        <Alert>
          <AlertTitle>Confirm it is you</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            Connecting a model needs a sign-in in the last 10 minutes. Sign in again, then connect.
            <Button
              type="button"
              size="sm"
              onClick={async () => {
                await authClient.signOut();
                navigate({ to: '/sign-in', search: { redirect: '/admin/stack' } });
              }}
            >
              Sign in again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Button type="submit" disabled={!signedIn || !model || connect.isPending}>
        Connect model
      </Button>
    </form>
  );
}

function ChatGptSignIn({
  signedIn,
  onError,
  onDone,
}: {
  signedIn: boolean;
  onError: (e: Error) => void;
  onDone: () => Promise<unknown>;
}) {
  const [device, setDevice] = useState<Device | null>(null);
  const start = useMutation({
    mutationFn: () => api<Device>('/api/admin/ai/logins/codex', { method: 'POST' }),
    onSuccess: setDevice,
    onError,
  });
  // While the code waits to be entered, ask the server every 3 s whether the sign-in finished.
  useQuery({
    queryKey: [...KEY, 'device'],
    queryFn: async () => {
      const ai = await api<Ai>('/api/admin/ai');
      const now = ai.logins?.device ?? null;
      if (now?.state !== 'pending') {
        setDevice(now);
        await onDone();
      }
      return now;
    },
    enabled: device?.state === 'pending',
    refetchInterval: 3000,
  });

  if (signedIn && device?.state !== 'pending') {
    return <p className="text-sm">Signed in to ChatGPT on this server.</p>;
  }
  if (device?.state === 'pending' && device.url && device.code) {
    return (
      <div className="space-y-3 rounded-md border p-4">
        <p className="text-sm">1. Open the sign-in page and sign in to your ChatGPT account.</p>
        <Button asChild variant="outline" size="sm">
          <a href={device.url} target="_blank" rel="noreferrer">
            <ExternalLink /> Open the sign-in page
          </a>
        </Button>
        <p className="text-sm">2. Enter this code there. It works for 15 minutes.</p>
        <div className="flex items-center gap-2">
          <code className="rounded-md bg-muted px-3 py-2 text-lg font-semibold tracking-widest">
            {device.code}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              navigator.clipboard.writeText(device.code ?? '').then(
                () => toast('Code copied'),
                () => toast.error('Could not copy. Select the code and copy it.'),
              )
            }
          >
            <Copy /> Copy
          </Button>
        </div>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Waiting for you to finish signing in
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {device?.state === 'failed' && (
        <p className="text-sm text-destructive">The sign-in did not finish. Start it again.</p>
      )}
      <Button
        type="button"
        variant="outline"
        onClick={() => start.mutate()}
        disabled={start.isPending}
      >
        {start.isPending && <Spinner />} Sign in with ChatGPT
      </Button>
    </div>
  );
}

function ClaudeSignIn({
  signedIn,
  onError,
  onDone,
}: {
  signedIn: boolean;
  onError: (e: Error) => void;
  onDone: () => Promise<unknown>;
}) {
  const [token, setToken] = useState('');
  const save = useMutation({
    mutationFn: () => api('/api/admin/ai/logins/claude', { method: 'PUT', json: { token } }),
    onSuccess: async () => {
      setToken('');
      toast('Claude token saved');
      await onDone();
    },
    onError,
  });
  return (
    <div className="space-y-3 rounded-md border p-4">
      {signedIn && <p className="text-sm">A Claude token is saved on this server.</p>}
      <p className="text-sm">
        On your computer, run <code className="rounded bg-muted px-1">claude setup-token</code>{' '}
        (Claude Code). It opens a sign-in page and then prints a token. Paste it here.
      </p>
      <div className="flex flex-wrap gap-2">
        <Label htmlFor="claude-token" className="sr-only">
          Claude token
        </Label>
        <Input
          id="claude-token"
          type="password"
          autoComplete="off"
          className="min-w-0 flex-1 basis-60"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={signedIn ? 'Paste a new token to replace it' : 'Paste the token'}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => save.mutate()}
          disabled={token.trim().length < 20 || save.isPending}
        >
          Save token
        </Button>
      </div>
    </div>
  );
}
