import {readFileSync} from 'node:fs';
import {parseIncrementalManifest,preflightIncrementalReports,applyIncrementalReports,withdrawIncrementalReports} from './postgres-report-incremental.mjs';

export const incrementalCloudTarget=Object.freeze({schema:'club_migration_live_20261002',appId:'wx47d5e3e20fd77f65'});
const root='/opt/club-report-incremental';
// Internal startup hook only: the caller has already validated runtime and PG.
// Dependency overrides are for isolated tests, never loaded from configuration.
export async function runCloudReportIncremental(pool,config,env,{read=readFileSync,preflight=preflightIncrementalReports,apply=applyIncrementalReports,withdraw=withdrawIncrementalReports}={}){
  const digest=env.CLUB_INCREMENTAL_REPORT_MANIFEST_SHA256,schema=env.CLUB_INCREMENTAL_REPORT_SCHEMA,mode=env.CLUB_INCREMENTAL_REPORT_MODE??'preflight';
  if(digest===undefined&&schema===undefined&&env.CLUB_INCREMENTAL_REPORT_MODE===undefined)return {enabled:false};
  if(!/^[a-f0-9]{64}$/.test(digest||'')||schema!==incrementalCloudTarget.schema||config.schema!==schema||config.appId!==incrementalCloudTarget.appId||config.mode!=='fresh'||config.reportStorage!=='postgres'||!['preflight','apply','withdraw'].includes(mode))throw Error('Explicit incremental report target mismatch');
  const manifestRaw=read(root+'/manifest.json'),parsed=parseIncrementalManifest(manifestRaw);
  if(parsed.manifestSha256!==digest||parsed.manifest.batchId!=='content-001-20261007')throw Error('Incremental report manifest mismatch');
  const o={schema,manifestRaw,expectedManifestSha256:digest,originalsDirectory:root+'/originals',previewsDirectory:root+'/previews'};
  const result=await ({preflight,apply,withdraw}[mode])(pool,o);
  // No credentials, filenames or full audit snapshots in container logs.
  return {enabled:true,mode,batchId:parsed.manifest.batchId,manifestSha256:digest,state:result.state,created:result.created?.length,skipped:result.skipped?.length,newReports:result.newReports?.length,publishable:result.publishable};
}
