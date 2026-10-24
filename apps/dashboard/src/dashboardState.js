export const stateClass = status => ({
  done: 'done',
  completed: 'done',
  review: 'review',
  in_progress: 'active',
  active: 'active',
  assigned: 'active',
  ready: 'ready',
  blocked: 'blocked',
  failed: 'failed',
  planned: 'todo',
  todo: 'todo',
}[status] || 'todo');

export const labelState = status => String(status || 'unknown').replaceAll('_', ' ');

export const isCoordinatorAuthenticated = (socketConnected, health) =>
  Boolean(socketConnected && health?.ok === true);
