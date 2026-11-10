import { afterEach, spyOn } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider, type QueryClientConfig } from '@tanstack/react-query';

export function queryClientFixture() {
  const clients: QueryClient[] = [];
  afterEach(() => {
    for (const client of clients.splice(0)) client.clear();
  });
  return (config?: QueryClientConfig) => {
    const client = new QueryClient(config);
    clients.push(client);
    return client;
  };
}

export function markupWithClient(client: QueryClient, node: ReactNode, route = '/') {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

export function captureWithClient<T>(client: QueryClient, read: () => T, route = '/'): T {
  let value!: T;
  function Fixture() {
    value = read();
    return null;
  }
  markupWithClient(client, <Fixture />, route);
  return value;
}

export function restoreSpies(...spies: { mockRestore: () => void }[]) {
  for (const spy of spies) spy.mockRestore();
}

export function spyFixture() {
  const spies: { mockRestore: () => void }[] = [];
  afterEach(() => restoreSpies(...spies.splice(0)));
  return <T extends object, K extends keyof T>(
    object: T,
    key: K,
  ): ReturnType<typeof spyOn<T, K>> => {
    const spy = spyOn(object, key);
    spies.push(spy);
    return spy;
  };
}
