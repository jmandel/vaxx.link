const defaultEnv = {
  PUBLIC_URL: 'http://localhost:8000',
  EMBED_MAX_BYTES: 10_000
};

async function envOrDefault(variable: string, defaultValue: string | number) {
  const havePermission = (await Deno.permissions.query({ name: 'env', variable })).state === 'granted';
  const ret = (havePermission && Deno.env.get(variable)) || '' + defaultValue;
  return typeof defaultValue === 'number' ? parseFloat(ret) : ret;
}

const env = Object.fromEntries(
  await Promise.all(Object.entries(defaultEnv).map(async ([k, v]) => [k, await envOrDefault(k, v)])),
) as typeof defaultEnv;

export default env;