/**
 * Browser-side shims for Node builtins.
 *
 * The renderer bundle statically imports a few engine modules that also
 * contain main-process tool handlers (fs/path/process usage at module top
 * level or inside never-called functions). These shims let the bundle
 * evaluate without crashing; the real handlers only ever run in the main
 * process, so nothing here is ever invoked for real work.
 */

const unavailable = (name: string) => (): never => {
  throw new Error(`${name} is unavailable in the renderer bundle`);
};

export const join = (...parts: string[]) => parts.filter(Boolean).join('/');
export const resolve = (...parts: string[]) => parts.filter(Boolean).join('/');
export const dirname = (p: string) => p.split('/').slice(0, -1).join('/') || '/';
export const basename = (p: string) => p.split('/').pop() ?? '';
export const extname = (p: string) => {
  const i = p.lastIndexOf('.');
  return i >= 0 ? p.slice(i) : '';
};
export const sep = '/';
export const delimiter = ':';
export const normalize = (p: string) => p;
export const isAbsolute = (p: string) => p.startsWith('/');
export const relative = (_from: string, to: string) => to;

export const existsSync = () => false;
export const readFileSync = unavailable('readFileSync');
export const writeFileSync = unavailable('writeFileSync');
export const mkdirSync = unavailable('mkdirSync');
export const readdirSync = () => [];
export const statSync = unavailable('statSync');
export const lstatSync = unavailable('statSync');
export const rmSync = unavailable('rmSync');
export const promises = new Proxy({}, {
  get: (_target, prop) => () => Promise.reject(new Error(`${String(prop)} is unavailable in the renderer bundle`)),
});

export const homedir = () => '/';
export const tmpdir = () => '/tmp';
export const platform = () => 'browser';

export const randomBytes = (n: number) => new Uint8Array(n);
export const createHash = unavailable('createHash');

// child_process
export const spawn = unavailable('spawn');
export const spawnSync = unavailable('spawnSync');
export const execFile = unavailable('execFile');
export const exec = unavailable('exec');
export const execSync = unavailable('execSync');
export const fork = unavailable('fork');

export default {};
