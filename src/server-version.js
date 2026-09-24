import minecraftData from 'minecraft-data';
import minecraftProtocol from 'minecraft-protocol';
import { ConfigError } from './config.js';

export function supportsServerVersion(version) {
  try {
    return Boolean(minecraftData(version));
  } catch {
    return false;
  }
}

export function latestSupportedServerVersion() {
  return minecraftData.versions.pc.find(candidate =>
    candidate.releaseType === 'release' && supportsServerVersion(candidate.minecraftVersion)
  )?.minecraftVersion;
}

export async function detectServerVersion(server, { ping = minecraftProtocol.ping } = {}) {
  const response = await ping({
    host: server.host,
    port: server.port,
    closeTimeout: 8_000,
    noPongTimeout: 1_000,
  });
  const protocol = response?.version?.protocol;
  if (!Number.isInteger(protocol)) throw new Error('o servidor não informou um protocolo válido');
  const candidates = minecraftData.postNettyVersionsByProtocolVersion.pc[protocol] ?? [];
  const release = candidates.find(candidate => candidate.releaseType === 'release') ?? candidates[0];
  if (!release?.minecraftVersion) {
    throw new Error(`o protocolo ${protocol} ainda não é conhecido pelas dependências instaladas`);
  }
  return {
    version: release.minecraftVersion,
    protocol,
    serverName: typeof response.version.name === 'string' ? response.version.name : release.minecraftVersion,
    supported: supportsServerVersion(release.minecraftVersion),
  };
}

export function assertSupportedServerVersion(version) {
  if (supportsServerVersion(version)) return;
  const latest = latestSupportedServerVersion();
  throw new ConfigError(
    `A versão ${version} do servidor foi identificada, mas ainda não é suportada pelas dependências instaladas. ` +
    `${latest ? `A versão mais recente disponível para o bot é ${latest}. ` : ''}` +
    'Se o servidor aceitar clientes antigos, execute npm run configure e informe essa versão; caso contrário, atualize a branch main e execute o instalador novamente quando o Mineflayer publicar o suporte.',
  );
}

export async function resolveServerVersion(config, { detect = detectServerVersion, save, log = console.log } = {}) {
  if (config.server.version !== 'auto') {
    assertSupportedServerVersion(config.server.version);
    return config;
  }

  log(`Consultando a versão de ${config.server.host}:${config.server.port}...`);
  let detected;
  try {
    detected = await detect(config.server);
  } catch (error) {
    throw new ConfigError(`Não foi possível detectar a versão do servidor: ${error.message}. Execute npm run configure para informá-la manualmente.`);
  }
  const next = structuredClone(config);
  next.server.version = detected.version;
  const saved = save ? await save(next) : next;
  log(`Versão detectada: ${detected.serverName} (protocolo ${detected.protocol}); salva como ${detected.version}.`);
  assertSupportedServerVersion(detected.version);
  return saved;
}
