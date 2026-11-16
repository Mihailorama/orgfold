// The product's name (APP_NAME on the server), read at run time: release images are built once
// for every product, so it cannot be baked into the bundle. Also sets the tab title.
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { client, ok } from '@/lib/api';

export function useAuthConfig() {
  return useQuery({
    queryKey: ['auth-config'],
    queryFn: () => ok(client.GET('/api/auth-config')),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useAppName() {
  const name = useAuthConfig().data?.appName;
  useEffect(() => {
    if (name) document.title = name;
  }, [name]);
  return name ?? '';
}
