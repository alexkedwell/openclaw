export type TeamScaleFixtureAsset = {
  body: string;
  contentType: string;
  status?: number;
  delayMs?: number;
};

export function teamScaleWidgetHtml(index: number) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Team metric ${index + 1}</title>
<style>:root{color-scheme:dark light;font-family:system-ui}body{margin:0;padding:20px}h2{font-size:18px}progress{width:100%}</style></head>
<body><h2>Team metric ${index + 1}</h2><p>Synthetic completed work: ${60 + index}%</p>
<progress value="${60 + index}" max="100"></progress><p>All fixture systems are available.</p></body></html>`;
}
