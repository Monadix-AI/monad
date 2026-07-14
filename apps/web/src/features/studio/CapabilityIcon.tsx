import { cn } from '@monad/ui';

export type CapabilityIconId =
  | 'code-execution'
  | 'delegation-mcp'
  | 'email-messaging'
  | 'file-system'
  | 'memory'
  | 'network-access'
  | 'process-runtime'
  | 'schedule-automation'
  | 'shell-terminal'
  | 'task-list'
  | 'vision-image'
  | 'web-extraction'
  | 'web-search';

const capabilityIconSrc: Record<CapabilityIconId, string> = {
  'code-execution': '/capability-icons/code-execution.png',
  'delegation-mcp': '/capability-icons/delegation-mcp.png',
  'email-messaging': '/capability-icons/email-messaging.png',
  'file-system': '/capability-icons/file-system.png',
  memory: '/capability-icons/memory.png',
  'network-access': '/capability-icons/network-access.png',
  'process-runtime': '/capability-icons/process-runtime.png',
  'schedule-automation': '/capability-icons/schedule-automation.png',
  'shell-terminal': '/capability-icons/shell-terminal.png',
  'task-list': '/capability-icons/task-list.png',
  'vision-image': '/capability-icons/vision-image.png',
  'web-extraction': '/capability-icons/web-extraction.png',
  'web-search': '/capability-icons/web-search.png'
};

export function CapabilityIcon({ className, icon }: { className?: string; icon: CapabilityIconId }) {
  return (
    <span
      aria-hidden="true"
      className={cn('block bg-center bg-contain bg-no-repeat', className)}
      style={{ backgroundImage: `url(${capabilityIconSrc[icon]})` }}
    />
  );
}

export function resolveCapabilityIcon(input: {
  detail?: string;
  name: string;
  sourceKind?: 'atom' | 'mcp';
}): CapabilityIconId {
  const text = `${input.name} ${input.detail ?? ''}`.toLowerCase();

  if (text.includes('shell') || text.includes('terminal') || text.includes('bash')) return 'shell-terminal';
  if (text.includes('file') || text.includes('fs') || text.includes('filesystem')) return 'file-system';
  if (text.includes('code') || text.includes('exec') || text.includes('run')) return 'code-execution';
  if (text.includes('process') || text.includes('runtime')) return 'process-runtime';
  if (text.includes('extract') || text.includes('fetch') || text.includes('page')) return 'web-extraction';
  if (text.includes('search') || text.includes('web')) return 'web-search';
  if (text.includes('network') || text.includes('net')) return 'network-access';
  if (text.includes('memory') || text.includes('mem')) return 'memory';
  if (text.includes('todo') || text.includes('task') || text.includes('checklist')) return 'task-list';
  if (text.includes('schedule') || text.includes('calendar')) return 'schedule-automation';
  if (text.includes('email') || text.includes('mail') || text.includes('smtp')) return 'email-messaging';
  if (text.includes('vision') || text.includes('image') || text.includes('camera')) return 'vision-image';
  if (text.includes('delegate') || text.includes('mcp') || input.sourceKind === 'mcp') return 'delegation-mcp';

  return input.sourceKind === 'atom' ? 'code-execution' : 'delegation-mcp';
}
