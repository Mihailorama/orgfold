// Operator console, Stack page (docs/admin.md "Stack"): every component of the company's stack
// with how it runs and whether it answers now. Changes run on the admin's machine
// (`pnpm run infra -- add <id>`, or `apply <id>` for a plan made and approved here), which shows
// the plan and changes nothing until approved.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageContainer, PageHeader } from '@/components/patterns/page-header';
import { QueryView } from '@/components/patterns/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { authClient } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { Section } from '@/pages/admin';
import { ModelSection, useAi } from '@/pages/admin-ai';

type Mode = 'install' | 'connect' | 'skip';
type Status = 'up' | 'down' | 'unchecked';
type Group = 'app' | 'base' | 'product' | 'tools';
type Component = {
  id: string;
  title: string;
  group: Group;
  description: string;
  modes: Mode[];
  mode: Mode | null;
  url: string | null;
  ramMiB: number | null;
  requires: Record<string, string[]>;
  status: Status;
  offers: Offer[];
};
/** A service with a free or cheap tier to connect (config/components.json `offers`). */
type Offer = { name: string; url: string; free: string; checked: string };
type Plan = {
  id: string;
  request: string;
  status: 'drafting' | 'ready' | 'failed' | 'off' | 'approved' | 'applied';
  reply: string | null;
  actions: { component: string; mode: Mode; fields: Field[]; offers: Offer[] }[];
  current: boolean;
  createdAt: string;
};
/** What a `connect` asks for; `entered` is the saved value, or a secret's last 4 characters. */
type Field = {
  key: string;
  label: string;
  secret: boolean;
  default: string | null;
  entered: string | null;
};
type Stack = {
  profile: { name: string; address: string; mailFrom: string | null };
  reported: boolean;
  checkedAt: string;
  components: Component[];
};

const GROUPS: [Group, string][] = [
  ['app', 'Application'],
  ['base', 'Base'],
  ['product', 'Product tools'],
  ['tools', 'Team tools'],
];
const MODE: Record<Mode, string> = {
  install: 'On this server',
  connect: 'Connected',
  skip: 'Not added',
};
const STATUS: Record<Status, { label: string; dot: string }> = {
  up: { label: 'Running', dot: 'bg-success' },
  down: { label: 'Not answering', dot: 'bg-destructive' },
  unchecked: { label: 'Not checked here', dot: 'bg-muted-foreground' },
};

const gib = (mib: number) => `${(mib / 1024).toFixed(1)} GiB`;
const inUse = (c: Component) => c.mode === 'install' || c.mode === 'connect';

export function AdminStackPage() {
  const stack = useQuery({
    queryKey: ['admin', 'stack'],
    queryFn: () => api<Stack>('/api/admin/stack'),
    refetchInterval: 60_000,
  });

  return (
    <PageContainer>
      <PageHeader
        title="Stack"
        description="What runs for the company, and whether it answers now."
        actions={
          <>
            {stack.data && (
              <span className="text-sm text-muted-foreground">
                Checked at{' '}
                {new Date(stack.data.checkedAt).toLocaleTimeString(undefined, {
                  timeStyle: 'short',
                })}
              </span>
            )}
            <Button variant="outline" onClick={() => stack.refetch()} disabled={stack.isFetching}>
              <RefreshCw className={cn(stack.isFetching && 'animate-spin')} /> Check again
            </Button>
          </>
        }
      />
      <QueryView query={stack} errorTitle="Could not load the stack">
        {(s) => <StackBody stack={s} />}
      </QueryView>
    </PageContainer>
  );
}

function StackBody({ stack }: { stack: Stack }) {
  const used = stack.components.filter(inUse);
  const free = stack.components.filter((c) => !inUse(c));
  const count = (st: Status) => used.filter((c) => c.status === st).length;
  const ram = used.reduce((sum, c) => sum + (c.mode === 'install' ? (c.ramMiB ?? 0) : 0), 0);
  const titleOf = (id: string) => stack.components.find((c) => c.id === id)?.title ?? id;

  return (
    <>
      {!stack.reported && (
        <Alert>
          <AlertTitle>This server has not reported its components yet</AlertTitle>
          <AlertDescription>
            Run pnpm run infra -- production from the machine you set up the servers from: it
            records how each component runs, and also deploys the newest release. Run pnpm run infra
            -- plan production first to see what it changes.
          </AlertDescription>
        </Alert>
      )}

      {stack.reported && (
        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm" aria-label="Summary">
          {(['up', 'down', 'unchecked'] as const).map((st) => (
            <div key={st} className="flex items-center gap-2">
              <span className={cn('size-2 rounded-full', STATUS[st].dot)} aria-hidden />
              <dt className="text-muted-foreground">{STATUS[st].label}</dt>
              <dd className="font-medium tabular-nums">{count(st)}</dd>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <dt className="text-muted-foreground">Memory reserved on the server</dt>
            <dd className="font-medium tabular-nums">{gib(ram)}</dd>
          </div>
        </dl>
      )}
      {stack.reported && (
        <p className="text-sm text-muted-foreground">
          Each check gives up after 3 seconds. Mail and services connected from outside are not
          reachable from here: pnpm run infra -- verify checks them and explains a failure.
        </p>
      )}

      <Section
        title="Company"
        description="Applied to every component at setup. Change it with pnpm run infra."
      >
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <Fact label="Name" value={stack.profile.name} />
          <Fact label="Address" value={stack.profile.address} />
          <Fact label="Mail sender" value={stack.profile.mailFrom ?? 'Not set'} />
        </dl>
      </Section>

      <ModelBlock />
      {stack.reported && <PlanSection components={stack.components} />}

      {stack.reported &&
        GROUPS.map(([g, label]) => {
          const rows = used.filter((c) => c.group === g);
          return rows.length ? (
            <section key={g} className="space-y-3" aria-labelledby={`stack-${g}`}>
              <h2 id={`stack-${g}`} className="text-lg font-semibold">
                {label}
              </h2>
              <Rows rows={rows} titleOf={titleOf} reported={stack.reported} />
            </section>
          ) : null;
        })}

      {free.length > 0 && (
        <section className="space-y-3" aria-labelledby="stack-add">
          <div className="space-y-1">
            <h2 id="stack-add" className="text-lg font-semibold">
              {stack.reported ? 'Add to the stack' : 'Catalog'}
            </h2>
            <p className="text-sm text-muted-foreground">
              Install a tool on this server, or connect the one the company already uses.
            </p>
          </div>
          <Rows rows={free} titleOf={titleOf} reported={stack.reported} />
        </section>
      )}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}

type RowProps = { titleOf: (id: string) => string; reported: boolean };

function Rows({ rows, ...props }: RowProps & { rows: Component[] }) {
  return (
    <Card className="py-0">
      <CardContent className="divide-y px-0">
        {rows.map((c) => (
          <Row key={c.id} c={c} {...props} />
        ))}
      </CardContent>
    </Card>
  );
}

function Mark({ title }: { title: string }) {
  return (
    <div
      className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground"
      aria-hidden
    >
      {title.slice(0, 2)}
    </div>
  );
}

function Row({ c, ...props }: RowProps & { c: Component }) {
  const used = inUse(c);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
      <Mark title={c.title} />
      <div className="min-w-0 flex-1 basis-56 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{c.title}</span>
          {used && c.mode && <Badge variant="secondary">{MODE[c.mode]}</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">{c.description}</p>
      </div>
      <div className="flex items-center gap-3">
        {used && <StatusDot status={c.status} />}
        {c.url && (
          <Button asChild variant="ghost" size="sm">
            <a href={c.url} target="_blank" rel="noreferrer">
              <ExternalLink /> Open
            </a>
          </Button>
        )}
        {c.id !== 'core' && <ChangeDialog c={c} {...props} />}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: Status }) {
  const s = STATUS[status];
  return (
    <span className="flex items-center gap-2 text-sm">
      <span className={cn('size-2 rounded-full', s.dot)} aria-hidden />
      {s.label}
    </span>
  );
}

function ChangeDialog({ c, titleOf, reported }: RowProps & { c: Component }) {
  const used = inUse(c);
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const command = `pnpm run infra -- add ${c.id}`;
  // One click makes a plan without the agent (like a marketplace's Install); it waits under "Plan
  // a change" for its connect card and approval, as the agent's plans do.
  const add = useMutation({
    mutationFn: (mode: Mode) =>
      api<Plan>('/api/admin/stack/plans', { method: 'POST', json: { component: c.id, mode } }),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'stack', 'plans'] });
      toast('Plan made: see Plan a change');
    },
    onError: (e) => toast.error(e.message),
  });
  // The base (database, S3, mail) changes only through `pnpm run infra` itself.
  const choices =
    c.group === 'base' ? [] : c.modes.filter((m) => m !== c.mode && (m !== 'skip' || used));
  const needs = (c.requires.install ?? []).map((r) => titleOf(r.split(':')[0] ?? r));
  const ways = c.modes.flatMap((m) => {
    if (m === 'install')
      return [
        `Install it on this server${c.ramMiB ? `: reserves ${gib(c.ramMiB)} of memory` : ''}${
          needs.length ? `, needs ${needs.join(' and ')} on this server` : ''
        }.`,
      ];
    if (m === 'connect') return ['Connect the one the company already uses (its address and key).'];
    return used ? ['Remove it from the stack; its data stays where it is.'] : [];
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={used ? 'outline' : 'default'} size="sm">
          {used ? 'Change' : 'Add'}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {used ? 'Change' : 'Add'} {c.title}
          </DialogTitle>
          <DialogDescription>
            Changes to the servers run from the machine you set them up from, so no one can change
            them from this page. A plan made here waits for your approval and that run.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {ways.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
        {c.modes.includes('connect') && <Offers offers={c.offers} />}
        {reported && choices.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {choices.map((m) => (
              <Button
                key={m}
                size="sm"
                variant={m === 'skip' ? 'outline' : 'default'}
                disabled={add.isPending}
                onClick={() => add.mutate(m)}
              >
                {VERB[m]}
              </Button>
            ))}
          </div>
        )}
        <div className="space-y-2">
          <p className="text-sm">{reported ? 'Or run on that machine:' : 'Run there:'}</p>
          <Command command={command} />
          <p className="text-sm text-muted-foreground">
            It asks how, shows the plan with the memory it needs, and changes nothing until you
            approve it.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Command({ command }: { command: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2">
      <code className="min-w-0 flex-1 truncate text-sm">{command}</code>
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          navigator.clipboard.writeText(command).then(
            () => toast('Command copied'),
            () => toast.error('Could not copy. Select the command and copy it.'),
          )
        }
      >
        <Copy /> Copy
      </Button>
    </div>
  );
}

const VERB: Record<Mode, string> = {
  install: 'Install on this server',
  connect: 'Connect the existing one',
  skip: 'Remove from the stack',
};
const PLAN_STATUS: Record<Plan['status'], string> = {
  drafting: 'Planning',
  ready: 'Waiting for approval',
  failed: 'No plan',
  off: 'Agent off',
  approved: 'Approved',
  applied: 'Applied',
};
const NOT_FRESH = 'approving needs a recent sign-in: sign in again, then approve';

/** "Plan a change": the agent turns a request into catalog actions (docs/admin.md). */
function ModelBlock() {
  const ai = useAi();
  return ai.data ? <ModelSection ai={ai.data} /> : null;
}

function PlanSection({ components }: { components: Component[] }) {
  const byId = new Map(components.map((c) => [c.id, c]));
  const queryClient = useQueryClient();
  const [request, setRequest] = useState('');
  const plans = useQuery({
    queryKey: ['admin', 'stack', 'plans'],
    queryFn: () => api<Plan[]>('/api/admin/stack/plans'),
    refetchInterval: (q) => (q.state.data?.some((p) => p.status === 'drafting') ? 3000 : false),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'stack', 'plans'] });
  const make = useMutation({
    mutationFn: () => api<Plan>('/api/admin/stack/plans', { method: 'POST', json: { request } }),
    onSuccess: async () => {
      setRequest('');
      await refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Section
      title="Plan a change"
      description="Say what the company needs. The agent plans it from the catalog; nothing changes until you approve the plan and run it."
    >
      <div className="space-y-6">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            make.mutate();
          }}
        >
          <label htmlFor="stack-request" className="sr-only">
            What should change
          </label>
          <Textarea
            id="stack-request"
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            placeholder="For example: we need a CRM for the sales team"
            maxLength={2000}
          />
          <Button type="submit" disabled={request.trim().length < 3 || make.isPending}>
            Make a plan
          </Button>
        </form>
        {plans.data?.length ? (
          <ul className="divide-y" aria-label="Plans">
            {plans.data.map((p) => (
              <PlanItem key={p.id} plan={p} byId={byId} onDone={refresh} />
            ))}
          </ul>
        ) : null}
      </div>
    </Section>
  );
}

function PlanItem({
  plan,
  byId,
  onDone,
}: {
  plan: Plan;
  byId: Map<string, Component>;
  onDone: () => Promise<unknown>;
}) {
  const navigate = useNavigate();
  const [stale, setStale] = useState(false);
  const approve = useMutation({
    mutationFn: () => api<Plan>(`/api/admin/stack/plans/${plan.id}/approve`, { method: 'POST' }),
    onSuccess: onDone,
    onError: (e) => (e.message === NOT_FRESH ? setStale(true) : toast.error(e.message)),
  });
  const open = plan.status === 'ready' || plan.status === 'approved';

  return (
    <li className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 basis-56 font-medium">{plan.request}</span>
        <Badge variant={plan.status === 'approved' ? 'default' : 'secondary'}>
          {plan.status === 'ready' && !plan.actions.length ? 'Answered' : PLAN_STATUS[plan.status]}
        </Badge>
      </div>
      {plan.reply && <p className="text-sm text-muted-foreground">{plan.reply}</p>}
      {plan.actions.length > 0 && (
        <ol className="space-y-2" aria-label="Actions">
          {plan.actions.map((a) => (
            <ActionCard
              key={a.component}
              action={a}
              c={byId.get(a.component)}
              planId={plan.id}
              editable={open && plan.current}
              onDone={onDone}
            />
          ))}
        </ol>
      )}
      {open && !plan.current && (
        <p className="text-sm text-muted-foreground">
          The stack changed since this plan was made. Ask again for a new plan.
        </p>
      )}
      {plan.status === 'ready' && plan.current && plan.actions.length > 0 && (
        <Button size="sm" onClick={() => approve.mutate()} disabled={approve.isPending}>
          Approve plan
        </Button>
      )}
      {stale && (
        <Alert>
          <AlertTitle>Confirm it is you</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            Approving a plan needs a sign-in in the last 10 minutes. Sign in again, then approve.
            <Button
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
      {plan.status === 'approved' && plan.current && (
        <div className="space-y-2">
          <p className="text-sm">
            Run it from the machine you set up the servers from. It takes what you entered above,
            asks for anything missing, shows what changes and runs the plan once:
          </p>
          <Command command={`pnpm run infra -- apply ${plan.id}`} />
        </div>
      )}
    </li>
  );
}

/**
 * One action of a plan, as a card. A `connect` card takes the address and keys right here (as
 * Lovable's and v0's chats ask for a secret): they go to the API, never to the agent, secrets are
 * encrypted at once and shown again only as their last 4 characters.
 */
function ActionCard({
  action,
  c,
  planId,
  editable,
  onDone,
}: {
  action: Plan['actions'][number];
  c: Component | undefined;
  planId: string;
  editable: boolean;
  onDone: () => Promise<unknown>;
}) {
  const title = c?.title ?? action.component;
  const missing = action.fields.filter((f) => !f.entered && !f.default).length;
  return (
    <li className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-3">
        <Mark title={title} />
        <div className="min-w-0 flex-1 basis-48 space-y-0.5">
          <div className="font-medium">{title}</div>
          <p className="text-sm text-muted-foreground">
            {VERB[action.mode]}
            {action.mode === 'install' && c?.ramMiB ? `, reserves ${gib(c.ramMiB)} of memory` : ''}
          </p>
        </div>
        {action.fields.length > 0 && (
          <Badge variant={missing ? 'outline' : 'secondary'}>
            {missing ? `${missing} to enter` : 'Ready to connect'}
          </Badge>
        )}
      </div>
      {editable && <Offers offers={action.offers} />}
      {action.fields.length > 0 &&
        (editable ? (
          <ConnectForm action={action} title={title} planId={planId} onDone={onDone} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {action.fields.map((f) => f.label).join('; ')}
          </p>
        ))}
    </li>
  );
}

function ConnectForm({
  action,
  title,
  planId,
  onDone,
}: {
  action: Plan['actions'][number];
  title: string;
  planId: string;
  onDone: () => Promise<unknown>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () =>
      api<Plan>(`/api/admin/stack/plans/${planId}/connect/${action.component}`, {
        method: 'PUT',
        json: { values: Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim())) },
      }),
    onSuccess: async () => {
      setValues({});
      await onDone();
      toast('Saved. Keys are encrypted and never shown again.');
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <form
      className="space-y-3"
      aria-label={`Connect ${title}`}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {action.fields.map((f) => {
        const id = `connect-${planId}-${f.key}`;
        return (
          <div key={f.key} className="space-y-1">
            <Label htmlFor={id}>{f.label}</Label>
            <Input
              id={id}
              type={f.secret ? 'password' : 'text'}
              autoComplete="off"
              value={values[f.key] ?? ''}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              placeholder={
                f.entered
                  ? f.secret
                    ? `Saved, ends in ${f.entered.slice(1)}`
                    : f.entered
                  : (f.default ?? '')
              }
            />
          </div>
        );
      })}
      <p className="text-sm text-muted-foreground">
        Sent to this server only, not to the agent. Keys are encrypted and used once, when the plan
        runs.
      </p>
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={save.isPending || !Object.values(values).some((v) => v.trim())}
      >
        Save
      </Button>
    </form>
  );
}

/** "No account yet?": services with a free or cheap tier, with the day their terms were checked. */
function Offers({ offers }: { offers: Offer[] }) {
  if (!offers.length) return null;
  return (
    <div className="space-y-1 text-sm">
      <p className="text-muted-foreground">No account yet? These start free or cheap:</p>
      <ul className="space-y-1">
        {offers.map((o) => (
          <li key={o.name}>
            <a href={o.url} target="_blank" rel="noreferrer" className="font-medium underline">
              {o.name}
            </a>
            <span className="text-muted-foreground">
              : {o.free} (checked {o.checked})
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
