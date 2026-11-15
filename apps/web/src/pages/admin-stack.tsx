// Operator console, Stack page (docs/admin.md "Stack"): every component of the company's stack
// with how it runs and whether it answers now. Read only: changes are `pnpm run infra -- add <id>`
// on the admin's machine, which shows a plan and changes nothing until approved.
import { useQuery } from '@tanstack/react-query';
import { Copy, ExternalLink, RefreshCw } from 'lucide-react';
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
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Section } from '@/pages/admin';

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

      {stack.reported &&
        GROUPS.map(([g, label]) => {
          const rows = used.filter((c) => c.group === g);
          return rows.length ? (
            <section key={g} className="space-y-3" aria-labelledby={`stack-${g}`}>
              <h2 id={`stack-${g}`} className="text-lg font-semibold">
                {label}
              </h2>
              <Rows rows={rows} titleOf={titleOf} />
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
          <Rows rows={free} titleOf={titleOf} />
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

function Rows({ rows, titleOf }: { rows: Component[]; titleOf: (id: string) => string }) {
  return (
    <Card className="py-0">
      <CardContent className="divide-y px-0">
        {rows.map((c) => (
          <Row key={c.id} c={c} titleOf={titleOf} />
        ))}
      </CardContent>
    </Card>
  );
}

function Row({ c, titleOf }: { c: Component; titleOf: (id: string) => string }) {
  const used = inUse(c);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
      <div
        className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground"
        aria-hidden
      >
        {c.title.slice(0, 2)}
      </div>
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
        {c.id !== 'core' && <ChangeDialog c={c} titleOf={titleOf} />}
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

function ChangeDialog({ c, titleOf }: { c: Component; titleOf: (id: string) => string }) {
  const used = inUse(c);
  const command = `pnpm run infra -- add ${c.id}`;
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
    <Dialog>
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
            them from this page.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {ways.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
        <div className="space-y-2">
          <p className="text-sm">Run there:</p>
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
          <p className="text-sm text-muted-foreground">
            It asks how, shows the plan with the memory it needs, and changes nothing until you
            approve it.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
