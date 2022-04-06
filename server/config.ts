const defaultEnv = {
  PUBLIC_URL: 'http://localhost:8000',
} as const;

async function envOrDefault(variable: string, defaultValue: string) {
  const havePermission = (await Deno.permissions.query({ name: 'env', variable })).state === 'granted';
  return (havePermission && Deno.env.get(variable)) || defaultValue;
}

const env = Object.fromEntries(
  await Promise.all(Object.entries(defaultEnv).map(async ([k, v]) => [k, await envOrDefault(k, v)])),
) as typeof defaultEnv;


export default env;