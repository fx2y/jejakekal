/**
 * @param {{workflowId: string, source: string}} params
 */
export async function startRun(params) {
  const response = await fetch('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflowId: params.workflowId, source: params.source })
  });
  return response.json();
}
