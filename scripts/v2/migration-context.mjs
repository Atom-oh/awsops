import { openSync, closeSync, fstatSync, readFileSync, constants } from 'node:fs';

const KEYS = [
  'version', 'commit', 'account', 'region', 'project', 'database',
  'endpoint', 'secret_arn', 'sql_reader_secret_arn',
].sort();
const invalid = () => { throw new Error('Invalid private CI migration context'); };

/** CI receives only independently discovered connection metadata, never raw TF state. */
export function readMigrationContext(path, expected) {
  let fd;
  let value;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.geteuid()
        || info.size <= 0 || info.size > 16384) invalid();
    value = JSON.parse(readFileSync(fd, 'utf8'));
  } catch {
    invalid();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(KEYS)
      || value.version !== 1 || value.database !== 'awsops') invalid();
  const shapes = {
    commit: /^[0-9a-f]{40}$/, account: /^[0-9]{12}$/,
    project: /^[a-z][a-z0-9-]{1,39}$/, region: /^[a-z]{2}-[a-z]+-[1-9][0-9]*$/,
  };
  for (const [key, pattern] of Object.entries(shapes)) {
    if (typeof expected[key] !== 'string' || !pattern.test(expected[key])
        || value[key] !== expected[key]) invalid();
  }
  if (typeof value.endpoint !== 'string' || !/^[a-z0-9][a-z0-9.-]+$/.test(value.endpoint)
      || !value.endpoint.startsWith(`${expected.project}-aurora.cluster-`)
      || !value.endpoint.endsWith(`.${expected.region}.rds.amazonaws.com`)) invalid();
  const prefix = `arn:aws:secretsmanager:${expected.region}:${expected.account}:secret:`;
  if (typeof value.secret_arn !== 'string' || !value.secret_arn.startsWith(prefix + 'rds!cluster-')
      || !/^[A-Za-z0-9/_+=.@!-]+-[A-Za-z0-9]{6}$/.test(value.secret_arn.slice(prefix.length))) invalid();
  if (value.sql_reader_secret_arn !== null) {
    const readerPrefix = `${prefix}ops/${expected.project}/agent/sql-reader-`;
    if (typeof value.sql_reader_secret_arn !== 'string'
        || !value.sql_reader_secret_arn.startsWith(readerPrefix)
        || !/^[A-Za-z0-9]{6}$/.test(value.sql_reader_secret_arn.slice(readerPrefix.length))) invalid();
  }
  return value;
}

/** Reconfirm file metadata against the owned cluster, not only its DNS suffix. */
export function validateMigrationDatabase(context, response) {
  const clusters = response?.DBClusters;
  if (!Array.isArray(clusters) || clusters.length !== 1) invalid();
  const db = clusters[0];
  const arn = `arn:aws:rds:${context.region}:${context.account}:cluster:${context.project}-aurora`;
  if (db.DBClusterArn !== arn || db.DBClusterIdentifier !== `${context.project}-aurora`
      || db.Endpoint !== context.endpoint || db.DatabaseName !== context.database
      || db.Status !== 'available' || db.MasterUserSecret?.SecretArn !== context.secret_arn
      || db.MasterUserSecret?.SecretStatus !== 'active') invalid();
  return context;
}
