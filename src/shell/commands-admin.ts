// Administration commands for the RHCSA networking, software, process, scheduling and time
// modules: nmcli, ip, flatpak, tuned-adm, ps/top/kill/nice/renice, at, timedatectl, chronyc.

import type { CommandContext, CommandResult } from './commands';
import { FLATPAK_APPS, NmConnection, TUNED_PROFILES } from './state';

type Command = (ctx: CommandContext) => CommandResult;

const ok = (stdout = ''): CommandResult => ({ stdout, stderr: '', code: 0 });
const fail = (stderr: string, code = 1): CommandResult => ({ stdout: '', stderr: stderr.endsWith('\n') ? stderr : stderr + '\n', code });
const isRoot = (ctx: CommandContext) => ctx.sh.uid === 0;

// ---------- networking ----------

const conByName = (ctx: CommandContext, name: string) =>
  ctx.sh.state.connections.find((c) => c.name === name || c.device === name);

const ipv4Ok = (a: string) => /^(\d{1,3})(\.\d{1,3}){3}(\/\d{1,2})?$/.test(a) && a.split('/')[0].split('.').every((n) => +n <= 255);
const ipv6Ok = (a: string) => /^[0-9a-fA-F:]+(\/\d{1,3})?$/.test(a) && a.includes(':');

function conShow(c: NmConnection) {
  return [
    `connection.id:                          ${c.name}`,
    `connection.interface-name:              ${c.device}`,
    `connection.autoconnect:                 ${c.autoconnect ? 'yes' : 'no'}`,
    `ipv4.method:                            ${c.ipv4.method}`,
    `ipv4.dns:                               ${c.ipv4.dns.join(',') || '--'}`,
    `ipv4.addresses:                         ${c.ipv4.addresses.join(', ') || '--'}`,
    `ipv4.gateway:                           ${c.ipv4.gateway || '--'}`,
    `ipv6.method:                            ${c.ipv6.method}`,
    `ipv6.addresses:                         ${c.ipv6.addresses.join(', ') || '--'}`,
    `ipv6.gateway:                           ${c.ipv6.gateway || '--'}`,
    `IP4.ADDRESS[1]:                         ${c.applied.ipv4[0] ?? '--'}`,
  ].join('\n') + '\n';
}

const nmcli: Command = (ctx) => {
  const args = ctx.args.filter((a) => a !== '-p' && a !== '--pretty');
  const obj = args[0] ?? '';
  const verb = args[1] ?? 'show';
  if ('general'.startsWith(obj) && obj) {
    if (args[1] === 'hostname') {
      if (args[2]) {
        if (!isRoot(ctx)) return fail('Error: Could not set hostname: Insufficient privileges.');
        ctx.sh.state.hostname = args[2];
        return ok();
      }
      return ok(ctx.sh.state.hostname + '\n');
    }
    return ok('STATE      CONNECTIVITY  WIFI-HW  WIFI     WWAN-HW  WWAN\nconnected  full          missing  enabled  missing  enabled\n');
  }
  if ('device'.startsWith(obj) && obj) {
    return ok('DEVICE  TYPE      STATE                   CONNECTION\nens160  ethernet  connected               ' + (ctx.sh.state.connections[0]?.name ?? '--') + '\nlo      loopback  connected (externally)  lo\n');
  }
  if (!obj || !'connection'.startsWith(obj)) {
    return fail('Usage: nmcli connection { show | add | modify | up | down | delete } ...\n       nmcli device status\n       nmcli general hostname [NAME]');
  }
  const cons = ctx.sh.state.connections;
  if ('show'.startsWith(verb)) {
    const name = args[2];
    if (name) {
      const c = conByName(ctx, name);
      return c ? ok(conShow(c)) : fail(`Error: ${name} - no such connection profile.`, 10);
    }
    return ok('NAME    UUID                                  TYPE      DEVICE\n' + cons.map((c) => `${c.name.padEnd(7)} 5fb06bd0-0bb0-7ffb-45f1-d6edd65f3e03  ethernet  ${c.applied.ipv4.length || c.applied.ipv6.length ? c.device : '--'}`).join('\n') + '\nlo      9a3e2b1c-8d7f-4e6a-b5c4-1d2e3f4a5b6c  loopback  lo\n');
  }
  if (!isRoot(ctx)) return fail('Error: Failed to modify connection: Insufficient privileges.\n(Hint: use sudo)');
  if ('modify'.startsWith(verb)) {
    const c = conByName(ctx, args[2] ?? '');
    if (!c) return fail(`Error: unknown connection '${args[2] ?? ''}'.`, 10);
    const pairs = args.slice(3);
    if (!pairs.length || pairs.length % 2) return fail('Error: value for the last property is missing.', 2);
    for (let i = 0; i < pairs.length; i += 2) {
      let key = pairs[i];
      const val = pairs[i + 1];
      const add = key.startsWith('+');
      const remove = key.startsWith('-');
      key = key.replace(/^[+-]/, '').replace(/^ip4$/, 'ipv4.addresses').replace(/^gw4$/, 'ipv4.gateway').replace(/^ip6$/, 'ipv6.addresses').replace(/^gw6$/, 'ipv6.gateway');
      const list = val.split(/[,\s]+/).filter(Boolean);
      const setList = (cur: string[], valid: (a: string) => boolean): string[] | string => {
        const bad = list.find((a) => !valid(a));
        if (bad) return `Error: failed to modify ${key}: invalid IP address: ${bad}.`;
        if (add) return [...cur, ...list.filter((a) => !cur.includes(a))];
        if (remove) return cur.filter((a) => !list.includes(a));
        return list;
      };
      switch (key) {
        case 'ipv4.method':
        case 'ipv6.method': {
          const v = val === 'static' ? 'manual' : val;
          if (!['auto', 'manual', 'disabled', 'ignore', 'link-local', 'dhcp'].includes(v)) return fail(`Error: failed to modify ${key}: '${val}' not among [auto, link-local, manual, shared, disabled].`);
          if (key === 'ipv4.method') c.ipv4.method = v as NmConnection['ipv4']['method'];
          else c.ipv6.method = v as NmConnection['ipv6']['method'];
          break;
        }
        case 'ipv4.addresses': {
          const r = setList(c.ipv4.addresses, ipv4Ok);
          if (typeof r === 'string') return fail(r);
          c.ipv4.addresses = r.map((a) => (a.includes('/') ? a : `${a}/32`));
          if (c.ipv4.addresses.length && c.ipv4.method === 'auto' && !add) c.ipv4.method = 'manual';
          break;
        }
        case 'ipv6.addresses': {
          const r = setList(c.ipv6.addresses, ipv6Ok);
          if (typeof r === 'string') return fail(r);
          c.ipv6.addresses = r.map((a) => (a.includes('/') ? a : `${a}/128`));
          if (c.ipv6.addresses.length && c.ipv6.method === 'auto' && !add) c.ipv6.method = 'manual';
          break;
        }
        case 'ipv4.gateway':
          if (!ipv4Ok(val)) return fail(`Error: failed to modify ipv4.gateway: invalid IP address: ${val}.`);
          c.ipv4.gateway = val;
          break;
        case 'ipv6.gateway':
          if (!ipv6Ok(val)) return fail(`Error: failed to modify ipv6.gateway: invalid IP address: ${val}.`);
          c.ipv6.gateway = val;
          break;
        case 'ipv4.dns': {
          const r = setList(c.ipv4.dns, ipv4Ok);
          if (typeof r === 'string') return fail(r);
          c.ipv4.dns = r;
          break;
        }
        case 'connection.autoconnect':
          c.autoconnect = /^(yes|true|1)$/.test(val);
          break;
        default:
          return fail(`Error: invalid or not allowed setting '${key}' (this practice terminal supports ipv4/ipv6 method, addresses, gateway, ipv4.dns and connection.autoconnect).`);
      }
    }
    return ok();
  }
  if ('up'.startsWith(verb)) {
    const c = conByName(ctx, args[2] ?? '');
    if (!c) return fail(`Error: unknown connection '${args[2] ?? ''}'.`, 10);
    if (c.ipv4.method === 'manual' && !c.ipv4.addresses.length) return fail(`Error: Connection activation failed: ipv4.addresses: this property cannot be empty for 'method=manual'`, 4);
    c.applied = {
      ipv4: c.ipv4.method === 'manual' ? [...c.ipv4.addresses] : c.ipv4.method === 'auto' ? ['192.168.4.157/24'] : [],
      ipv6: c.ipv6.method === 'manual' ? [...c.ipv6.addresses] : [],
    };
    return ok('Connection successfully activated (D-Bus active path: /org/freedesktop/NetworkManager/ActiveConnection/2)\n');
  }
  if ('down'.startsWith(verb)) {
    const c = conByName(ctx, args[2] ?? '');
    if (!c) return fail(`Error: '${args[2] ?? ''}' is not an active connection.`, 10);
    c.applied = { ipv4: [], ipv6: [] };
    return ok(`Connection '${c.name}' successfully deactivated.\n`);
  }
  if ('add'.startsWith(verb)) {
    const opts: Record<string, string> = {};
    for (let i = 2; i < args.length; i += 2) opts[args[i]] = args[i + 1] ?? '';
    const name = opts['con-name'] ?? opts.ifname ?? 'ethernet';
    if (cons.some((c) => c.name === name)) return fail(`Error: connection '${name}' already exists.`);
    const ip4 = opts['ipv4.addresses'] ?? opts.ip4;
    cons.push({
      name,
      device: opts.ifname ?? 'ens192',
      autoconnect: true,
      ipv4: { method: ip4 ? 'manual' : 'auto', addresses: ip4 ? [ip4] : [], gateway: opts['ipv4.gateway'] ?? opts.gw4 ?? '', dns: [] },
      ipv6: { method: 'auto', addresses: [], gateway: '' },
      applied: { ipv4: [], ipv6: [] },
    });
    return ok(`Connection '${name}' (2b1d4e3a-5c6f-4a7b-8c9d-0e1f2a3b4c5d) successfully added.\n`);
  }
  if ('delete'.startsWith(verb)) {
    const c = conByName(ctx, args[2] ?? '');
    if (!c) return fail(`Error: unknown connection '${args[2] ?? ''}'.`, 10);
    ctx.sh.state.connections = cons.filter((x) => x !== c);
    return ok(`Connection '${c.name}' successfully deleted.\n`);
  }
  if ('reload'.startsWith(verb)) return ok();
  return fail(`Error: argument '${verb}' not understood.`, 2);
};

const ip: Command = (ctx) => {
  const sub = ctx.args[0] ?? '';
  const cons = ctx.sh.state.connections;
  if (sub.startsWith('a')) {
    let out = `1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000\n    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n    inet 127.0.0.1/8 scope host lo\n    inet6 ::1/128 scope host\n`;
    const c = cons.find((x) => x.device === 'ens160');
    out += `2: ens160: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP group default qlen 1000\n    link/ether 00:0c:29:3a:7b:1f brd ff:ff:ff:ff:ff:ff\n`;
    for (const a of c?.applied.ipv4 ?? []) out += `    inet ${a} scope global noprefixroute ens160\n`;
    for (const a of c?.applied.ipv6 ?? []) out += `    inet6 ${a} scope global noprefixroute\n`;
    out += `    inet6 fe80::20c:29ff:fe3a:7b1f/64 scope link noprefixroute\n`;
    return ok(out);
  }
  if (sub.startsWith('r')) {
    const c = cons.find((x) => x.device === 'ens160');
    const gw = c?.ipv4.gateway;
    const net = c?.applied.ipv4[0];
    return ok((gw ? `default via ${gw} dev ens160 proto static metric 100\n` : '') + (net ? `${net.replace(/\.\d+\//, '.0/')} dev ens160 proto kernel scope link src ${net.split('/')[0]} metric 100\n` : ''));
  }
  if (sub.startsWith('l')) return ok('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 state UNKNOWN\n2: ens160: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP\n');
  return fail('Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }\nwhere  OBJECT := { address | link | route | ... }');
};

// ---------- Flatpak ----------

const flatpak: Command = (ctx) => {
  const args = ctx.args.filter((a) => !['-y', '--assumeyes', '--system', '--noninteractive'].includes(a));
  const [verb, ...rest] = args;
  const st = ctx.sh.state;
  const needRoot = () => (isRoot(ctx) ? null : fail('error: Flatpak system operation requires root here. (Hint: use sudo, or --user for a per-user install.)'));
  switch (verb) {
    case 'remotes':
      return ok('Name    Options\n' + st.flatpakRemotes.map((r) => `${r.padEnd(7)} system`).join('\n') + '\n');
    case 'remote-add': {
      const r = needRoot();
      if (r) return r;
      const ops = rest.filter((a) => !a.startsWith('--'));
      const [name, url] = ops;
      if (!name || !url) return fail('error: NAME and LOCATION must be specified');
      if (st.flatpakRemotes.includes(name)) {
        if (rest.includes('--if-not-exists')) return ok();
        return fail(`error: Remote ${name} already exists`);
      }
      if (!/^https?:\/\//.test(url)) return fail(`error: Can't load uri ${url}`);
      st.flatpakRemotes.push(name);
      return ok();
    }
    case 'remote-delete': {
      const r = needRoot();
      if (r) return r;
      st.flatpakRemotes = st.flatpakRemotes.filter((x) => x !== rest[0]);
      return ok();
    }
    case 'search': {
      const term = (rest[0] ?? '').toLowerCase();
      if (!st.flatpakRemotes.includes('flathub')) return ok('No matches found\n');
      const hits = Object.entries(FLATPAK_APPS).filter(([id, n]) => id.toLowerCase().includes(term) || n.toLowerCase().includes(term));
      return ok(hits.length ? 'Name          Application ID                 Remotes\n' + hits.map(([id, n]) => `${n.padEnd(13)} ${id.padEnd(30)} flathub`).join('\n') + '\n' : 'No matches found\n');
    }
    case 'install': {
      const r = needRoot();
      if (r) return r;
      const ops = rest.filter((a) => !a.startsWith('--'));
      const app = ops.length > 1 ? ops[1] : ops[0];
      const remote = ops.length > 1 ? ops[0] : 'flathub';
      if (!app) return fail('error: At least one REF must be specified');
      if (!st.flatpakRemotes.includes(remote)) return fail(`error: No remote refs found for '${remote}'${remote === 'flathub' ? '. (Hint: add the flathub remote first with flatpak remote-add)' : ''}`);
      const id = Object.keys(FLATPAK_APPS).find((k) => k.toLowerCase() === app.toLowerCase() || FLATPAK_APPS[k].toLowerCase() === app.toLowerCase());
      if (!id) return fail(`error: Nothing matches ${app} in remote ${remote}`);
      if (st.flatpakApps.includes(id)) return ok(`${id} is already installed\n`);
      st.flatpakApps.push(id);
      return ok(`Installing ${id}...\nInstallation complete.\n`);
    }
    case 'uninstall':
    case 'remove': {
      const r = needRoot();
      if (r) return r;
      const id = st.flatpakApps.find((a) => a === rest[0] || FLATPAK_APPS[a].toLowerCase() === (rest[0] ?? '').toLowerCase());
      if (!id) return fail(`error: ${rest[0] ?? ''} not installed`);
      st.flatpakApps = st.flatpakApps.filter((a) => a !== id);
      return ok(`Uninstalling ${id}...\nUninstall complete.\n`);
    }
    case 'list':
      return ok(st.flatpakApps.length ? 'Name          Application ID                 Origin\n' + st.flatpakApps.map((id) => `${FLATPAK_APPS[id].padEnd(13)} ${id.padEnd(30)} flathub`).join('\n') + '\n' : '');
    case 'run':
      return st.flatpakApps.includes(rest[0] ?? '') ? ok(`(${rest[0]} is a graphical app; on a real desktop it would open now.)\n`) : fail(`error: app/${rest[0] ?? ''}/x86_64/master not installed`);
    default:
      return fail('Usage: flatpak [remotes|remote-add|remote-delete|search|install|uninstall|list|run] ...');
  }
};

// ---------- tuned ----------

const tunedAdm: Command = (ctx) => {
  const [verb, profile] = ctx.args;
  const st = ctx.sh.state;
  switch (verb) {
    case 'active':
      return ok(`Current active profile: ${st.tunedProfile}\n`);
    case 'list':
      return ok('Available profiles:\n' + Object.entries(TUNED_PROFILES).map(([k, v]) => `- ${k.padEnd(24)}- ${v}`).join('\n') + `\nCurrent active profile: ${st.tunedProfile}\n`);
    case 'recommend':
      return ok('virtual-guest\n');
    case 'profile':
      if (!profile) return ok('Available profiles:\n' + Object.keys(TUNED_PROFILES).map((k) => `- ${k}`).join('\n') + '\n');
      if (!isRoot(ctx)) return fail('Cannot talk to TuneD daemon via DBus. Is TuneD daemon running? (Hint: use sudo)');
      if (!TUNED_PROFILES[profile]) return fail(`Requested profile '${profile}' doesn't exist.`);
      st.tunedProfile = profile;
      return ok();
    case 'off':
      if (!isRoot(ctx)) return fail('Cannot talk to TuneD daemon via DBus.');
      st.tunedProfile = '(none)';
      return ok();
    default:
      return fail('usage: tuned-adm [active|list|profile NAME|recommend|off]');
  }
};

// ---------- processes ----------

const ps: Command = (ctx) => {
  const a = ctx.args.join(' ');
  const procs = ctx.sh.state.processes;
  const sortCpu = /--sort[= ]-?%?cpu|-pcpu/.test(a);
  const sortMem = /--sort[= ]-?%?mem|-pmem/.test(a);
  const list = [...procs];
  if (sortCpu) list.sort((x, y) => y.cpu - x.cpu);
  if (sortMem) list.sort((x, y) => y.mem - x.mem);
  if (!/aux|ef|-e|ax/.test(a)) {
    return ok('    PID TTY          TIME CMD\n   1602 pts/0    00:00:00 bash\n   1688 pts/0    00:00:00 ps\n');
  }
  if (/-eo|-o/.test(a)) {
    return ok('    PID  NI %CPU %MEM CMD\n' + list.map((p) => `${String(p.pid).padStart(7)} ${String(p.nice).padStart(3)} ${p.cpu.toFixed(1).padStart(4)} ${p.mem.toFixed(1).padStart(4)} ${p.cmd}`).join('\n') + '\n');
  }
  return ok(
    'USER         PID %CPU %MEM STAT  NI COMMAND\n' +
      list.map((p) => `${p.user.padEnd(10)} ${String(p.pid).padStart(5)} ${p.cpu.toFixed(1).padStart(4)} ${p.mem.toFixed(1).padStart(4)} ${p.cpu > 50 ? 'R ' : 'S '}  ${String(p.nice).padStart(3)} ${p.cmd}`).join('\n') +
      '\n',
  );
};

const top: Command = (ctx) => {
  const list = [...ctx.sh.state.processes].sort((x, y) => y.cpu - x.cpu);
  return ok(
    `top - 15:42:07 up 3 days,  4:11,  1 user,  load average: 1.02, 0.98, 0.71\nTasks: ${list.length} total,   1 running\n%Cpu(s): 48.6 us,  1.2 sy,  0.0 ni, 50.1 id\nMiB Mem :   3652.6 total,   1180.4 free\n\n    PID USER      PR  NI %CPU %MEM COMMAND\n` +
      list.map((p) => `${String(p.pid).padStart(7)} ${p.user.padEnd(9)} ${String(20 + p.nice).padStart(2)} ${String(p.nice).padStart(3)} ${p.cpu.toFixed(1).padStart(4)} ${p.mem.toFixed(1).padStart(4)} ${p.cmd.split(' ')[0].split('/').pop()}`).join('\n') +
      '\n\n(Practice terminal: top shows one snapshot. On a real system, press k to kill, r to renice, q to quit.)\n',
  );
};

function signalProcs(ctx: CommandContext, pids: number[], name: string): CommandResult {
  let err = '';
  for (const pid of pids) {
    const p = ctx.sh.state.processes.find((x) => x.pid === pid);
    if (!p) {
      err += `-bash: ${name}: (${pid}) - No such process\n`;
      continue;
    }
    if (!isRoot(ctx) && p.user !== ctx.sh.user.name) {
      err += `-bash: ${name}: (${pid}) - Operation not permitted\n`;
      continue;
    }
    if (pid === 1) continue; // init ignores it
    ctx.sh.state.processes = ctx.sh.state.processes.filter((x) => x !== p);
  }
  return err ? fail(err) : ok();
}

const kill: Command = (ctx) => {
  if (ctx.args[0] === '-l') return ok(' 1) SIGHUP\t 2) SIGINT\t 9) SIGKILL\t15) SIGTERM\t18) SIGCONT\t19) SIGSTOP\n');
  const pids = ctx.args.filter((a) => /^\d+$/.test(a)).map(Number);
  if (!pids.length) return fail('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]', 2);
  return signalProcs(ctx, pids, 'kill');
};

const pkill: Command = (ctx) => {
  const pattern = ctx.args.filter((a) => !a.startsWith('-')).pop();
  if (!pattern) return fail('pkill: no matching criteria specified', 2);
  const pids = ctx.sh.state.processes.filter((p) => p.cmd.includes(pattern) && p.pid !== 1).map((p) => p.pid);
  if (!pids.length) return { stdout: '', stderr: '', code: 1 };
  return signalProcs(ctx, pids, 'pkill');
};

const nice: Command = (ctx) => {
  let n = 10;
  let i = 0;
  if (ctx.args[0] === '-n') {
    n = parseInt(ctx.args[1], 10);
    i = 2;
  } else if (/^-\d+$/.test(ctx.args[0] ?? '')) {
    n = parseInt(ctx.args[0].slice(1), 10);
    i = 1;
  }
  const cmd = ctx.args.slice(i).join(' ');
  if (!cmd) return ok('0\n');
  if (n < 0 && !isRoot(ctx)) return fail('nice: cannot set niceness: Permission denied');
  const pid = Math.max(...ctx.sh.state.processes.map((p) => p.pid)) + 7;
  ctx.sh.state.processes.push({ pid, user: ctx.sh.user.name, cpu: 12.5, mem: 0.2, nice: Math.max(-20, Math.min(19, n)), cmd });
  return ok(`[1] ${pid}\n(Started "${cmd}" in the background with nice ${n}.)\n`);
};

const renice: Command = (ctx) => {
  let n: number | undefined;
  const pids: number[] = [];
  for (let i = 0; i < ctx.args.length; i++) {
    const a = ctx.args[i];
    if (a === '-n') n = parseInt(ctx.args[++i], 10);
    else if (a === '-p') continue;
    else if (/^-?\d+$/.test(a)) {
      if (n === undefined) n = parseInt(a, 10);
      else pids.push(parseInt(a, 10));
    }
  }
  if (n === undefined || !pids.length) return fail('usage: renice -n PRIORITY -p PID');
  let out = '';
  for (const pid of pids) {
    const p = ctx.sh.state.processes.find((x) => x.pid === pid);
    if (!p) return fail(`renice: failed to get priority for ${pid} (process ID): No such process`);
    if (!isRoot(ctx) && (p.user !== ctx.sh.user.name || n < p.nice)) return fail(`renice: failed to set priority for ${pid} (process ID): Permission denied`);
    out += `${pid} (process ID) old priority ${p.nice}, new priority ${n}\n`;
    p.nice = Math.max(-20, Math.min(19, n));
  }
  return ok(out);
};

// ---------- at ----------

const at: Command = (ctx) => {
  if (ctx.args[0] === '-l') return atq(ctx);
  if (ctx.args[0] === '-d' || ctx.args[0] === '-r') return atrm({ ...ctx, args: ctx.args.slice(1) });
  const when = ctx.args.join(' ');
  if (!when) return fail('Garbled time');
  if (!/^(now|noon|midnight|teatime|tomorrow|\d{1,2}(:\d{2})?\s*(am|pm)?)/i.test(when)) return fail('syntax error. Last token seen: ' + ctx.args[0] + '\nGarbled time');
  const cmd = ctx.stdin.trim();
  if (!cmd) return fail('at reads the commands from standard input. On the phone terminal, pipe them in:\n  echo "touch /tmp/hello" | at now + 5 minutes');
  const jobs = ctx.sh.state.atJobs;
  const id = (jobs.reduce((m, j) => Math.max(m, j.id), 0) || 0) + 1;
  jobs.push({ id, when, user: ctx.sh.user.name, cmd });
  return { stdout: '', stderr: `warning: commands will be executed using /bin/sh\njob ${id} at ${when}\n`, code: 0 };
};

const atq: Command = (ctx) => {
  const jobs = ctx.sh.state.atJobs.filter((j) => isRoot(ctx) || j.user === ctx.sh.user.name);
  return ok(jobs.map((j) => `${j.id}\t${j.when} a ${j.user}`).join('\n') + (jobs.length ? '\n' : ''));
};

const atrm: Command = (ctx) => {
  for (const a of ctx.args) {
    const id = parseInt(a, 10);
    const job = ctx.sh.state.atJobs.find((j) => j.id === id);
    if (!job) return fail(`Cannot find jobid ${a}`);
    ctx.sh.state.atJobs = ctx.sh.state.atJobs.filter((j) => j !== job);
  }
  return ok();
};

// ---------- time ----------

const ZONES = ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Europe/Amsterdam', 'Europe/London', 'Asia/Tokyo', 'Australia/Sydney', 'UTC'];

const timedatectl: Command = (ctx) => {
  const [verb, val] = ctx.args;
  const st = ctx.sh.state;
  if (!verb || verb === 'status') {
    return ok(`               Local time: Tue 2026-10-21 11:42:07 EDT\n           Universal time: Tue 2026-10-21 15:42:07 UTC\n                Time zone: ${st.timezone}\nSystem clock synchronized: ${st.ntp ? 'yes' : 'no'}\n              NTP service: ${st.ntp ? 'active' : 'inactive'}\n          RTC in local TZ: no\n`);
  }
  if (verb === 'list-timezones') return ok(ZONES.join('\n') + '\n');
  if (!isRoot(ctx)) return fail('Failed to set: Access denied (Hint: use sudo)');
  if (verb === 'set-timezone') {
    if (!ZONES.includes(val ?? '')) return fail(`Failed to set time zone: Invalid or not installed time zone '${val ?? ''}'`);
    st.timezone = val;
    return ok();
  }
  if (verb === 'set-ntp') {
    st.ntp = /^(true|yes|1)$/.test(val ?? '');
    if (st.services.chronyd) st.services.chronyd.active = st.ntp;
    return ok();
  }
  if (verb === 'set-time') return st.ntp ? fail('Failed to set time: Automatic time synchronization is enabled') : ok();
  return fail(`Unknown command verb ${verb}.`);
};

const chronyc: Command = (ctx) => {
  const verb = ctx.args[0] ?? '';
  const conf = (() => {
    try {
      return ctx.sh.readFile('/etc/chrony.conf');
    } catch {
      return '';
    }
  })();
  const servers = [...conf.matchAll(/^(?:server|pool)\s+(\S+)/gm)].map((m) => m[1]);
  if (!ctx.sh.state.services.chronyd?.active) return fail('506 Cannot talk to daemon');
  if (verb === 'sources') {
    return ok('MS Name/IP address         Stratum Poll Reach LastRx Last sample\n===============================================================================\n' + servers.map((s, i) => `^${i === 0 ? '*' : '-'} ${s.padEnd(27)} 2   6   377    23   +112us[ +140us] +/-   18ms`).join('\n') + '\n');
  }
  if (verb === 'tracking') return ok(`Reference ID    : C0A80401 (${servers[0] ?? 'none'})\nStratum         : 3\nSystem time     : 0.000012 seconds fast of NTP time\nLeap status     : Normal\n`);
  return fail('usage: chronyc [sources|tracking]');
};

export const ADMIN_COMMANDS: Record<string, Command> = {
  nmcli, ip, flatpak, 'tuned-adm': tunedAdm, ps, top, kill, pkill, nice, renice, at, atq, atrm, timedatectl, chronyc,
};
