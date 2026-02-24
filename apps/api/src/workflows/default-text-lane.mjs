/**
 * @param {string} path
 * @param {(path: string, encoding: BufferEncoding) => Promise<string>} readTextFile
 */
async function readMarkerJson(path, readTextFile) {
  return JSON.parse(await readTextFile(path, 'utf8'));
}

/**
 * @param {{ value: string, sleepMs?: number, bundlesRoot: string, useLlm?: boolean, pauseAfterS4Ms?: number, ocrPolicy?: Record<string, unknown> }} input
 * @param {{
 *   workflowId: string,
 *   readTextFile: (path: string, encoding: BufferEncoding) => Promise<string>,
 *   runS0ReserveDoc: (input: {value: string}) => Promise<{raw_sha:string,doc_id:string,ver:number,marker_config_sha:string}>,
 *   runS1StoreRaw: (input: {workflowId:string,source:string,rawSha:string,docId:string,version:number}) => Promise<unknown>,
 *   runS1Sleep: (input: {sleepMs?:number}) => Promise<void>,
 *   runS2MarkerConvert: (input: {workflowId:string, source:string, docId:string, version:number, bundlesRoot:string, useLlm?:boolean}) => Promise<any>,
 *   runS3StoreParseOutputs: (input: {workflowId:string,rawSha:string,docId:string,version:number,markerConfigSha:string,parsed:any}) => Promise<any>,
 *   runS4NormalizeDocir: (input: {docId:string,version:number,rawSha:string,markerConfigSha:string,markerJson:Record<string, unknown>,marker:{version?:string,stdout_sha256?:string,stderr_sha256?:string},parseKeys:string[],parseShaByKey:Record<string,string>}) => Promise<any>,
 *   runS4xAfterNormalize?: (input: {workflowId:string,reserved:{raw_sha:string,doc_id:string,ver:number,marker_config_sha:string},markerJson:Record<string, unknown>,normalized:any,ocrPolicy?:Record<string, unknown>}) => Promise<void>,
 *   runS4ToS5Pause: (pauseAfterS4Ms: number | undefined) => Promise<void>,
 *   runS5IndexFts: (input: {workflowId:string,docId:string,version:number,language?:string}) => Promise<any>,
 *   runS6EmitExecMemo: (input: {workflowId:string,docId:string,version:number,rawSha:string,markerConfigSha:string}) => Promise<any>,
 *   runS7ArtifactCount: (workflowId:string) => Promise<number>,
 *   runS8ArtifactPostcondition: (artifactCount:number) => void
 * }} deps
 */
export async function runDefaultTextLane(input, deps) {
  const reserved = await deps.runS0ReserveDoc(input);
  await deps.runS1StoreRaw({
    workflowId: deps.workflowId,
    source: input.value,
    rawSha: reserved.raw_sha,
    docId: reserved.doc_id,
    version: reserved.ver
  });
  await deps.runS1Sleep(input);
  const marker = await deps.runS2MarkerConvert({
    workflowId: deps.workflowId,
    source: input.value,
    docId: reserved.doc_id,
    version: reserved.ver,
    bundlesRoot: input.bundlesRoot,
    useLlm: input.useLlm
  });
  const markerJson = await readMarkerJson(marker.paths.docir, deps.readTextFile);
  const persisted = await deps.runS3StoreParseOutputs({
    workflowId: deps.workflowId,
    rawSha: reserved.raw_sha,
    docId: reserved.doc_id,
    version: reserved.ver,
    markerConfigSha: reserved.marker_config_sha,
    parsed: marker
  });
  const normalized = await deps.runS4NormalizeDocir({
    docId: reserved.doc_id,
    version: reserved.ver,
    rawSha: reserved.raw_sha,
    markerConfigSha: reserved.marker_config_sha,
    markerJson,
    marker: {
      version: marker.marker?.version,
      stdout_sha256: marker.marker?.stdout_sha256,
      stderr_sha256: marker.marker?.stderr_sha256
    },
    parseKeys: persisted.parse_keys,
    parseShaByKey: persisted.parse_sha_by_key
  });
  if (deps.runS4xAfterNormalize) {
    await deps.runS4xAfterNormalize({
      workflowId: deps.workflowId,
      reserved,
      markerJson,
      normalized,
      ocrPolicy: input.ocrPolicy
    });
  }
  await deps.runS4ToS5Pause(input.pauseAfterS4Ms);
  await deps.runS5IndexFts({
    workflowId: deps.workflowId,
    docId: reserved.doc_id,
    version: reserved.ver
  });
  const memo = await deps.runS6EmitExecMemo({
    workflowId: deps.workflowId,
    docId: reserved.doc_id,
    version: reserved.ver,
    rawSha: reserved.raw_sha,
    markerConfigSha: reserved.marker_config_sha
  });
  const artifactCount = await deps.runS7ArtifactCount(deps.workflowId);
  deps.runS8ArtifactPostcondition(artifactCount);
  return { workflowId: deps.workflowId, reserved, marker, persisted, normalized, memo };
}
