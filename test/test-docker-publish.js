import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../.github/workflows/docker-publish.yml', import.meta.url),
  'utf8'
);
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const installation = readFileSync(new URL('../docs/installation.md', import.meta.url), 'utf8');

function namedWorkflowStep(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line === `      - name: ${name}`);
  assert.notEqual(start, -1, `The ${name} workflow step must exist`);
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && /^ {0,6}\S/.test(line)) break;
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

test('Docker publish treats the remote build cache as an optional optimization', () => {
  assert.match(
    workflow,
    /cache-to:.*type=gha,mode=max,ignore-error=true/,
    'A failed GitHub Actions cache export must not fail an otherwise successful image push'
  );
});

test('a release image is built without the layer cache, main keeps it (#2635)', () => {
  // Der gha-Cache ist je Repository geteilt: ein Tag-Build konnte Layer aus einem
  // frueheren main-Build uebernehmen, npm ci und der Vite-Build der Build-Stage
  // eingeschlossen. Ein Release-Image entsteht deshalb immer frisch aus dem Tag;
  // der Cache bleibt den Branch-Builds, wo er Minuten spart und nichts ausliefert,
  // was jemand pinnt. Entscheidung Ulas, 10.11.2026.
  const step = workflow.slice(workflow.indexOf('- name: Build and push'), workflow.indexOf('- name: Install cosign'));
  const isTag = "startsWith(github.ref, 'refs/tags/v')";
  assert.ok(step.includes(`no-cache: \${{ ${isTag} }}`), 'tag builds pass --no-cache');
  assert.ok(step.includes(`cache-from: \${{ !${isTag} && 'type=gha' || '' }}`), 'tag builds import no cache');
  assert.ok(step.includes(`cache-to: \${{ !${isTag} && 'type=gha,mode=max,ignore-error=true' || '' }}`), 'tag builds export no cache');
  // Kein zweiter Weg an der Bedingung vorbei.
  assert.equal((step.match(/^\s+cache-from:/gm) || []).length, 1);
  assert.equal((step.match(/^\s+cache-to:/gm) || []).length, 1);
  assert.equal((step.match(/^\s+no-cache:/gm) || []).length, 1);
});

test('Docker publishing injects the immutable Git revision into the image', () => {
  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM ') + 1);
  const revisionArg = runtimeStage.indexOf('\nARG APP_BUILD_REVISION\n');
  const revisionEnv = runtimeStage.indexOf('\nENV APP_BUILD_REVISION=${APP_BUILD_REVISION}\n');
  assert.notEqual(revisionArg, -1, 'The runtime stage must declare APP_BUILD_REVISION');
  assert.ok(revisionEnv > revisionArg, 'ARG APP_BUILD_REVISION must precede the ENV that expands it');
  assert.ok(
    revisionArg > runtimeStage.lastIndexOf('\nRUN ')
      && revisionArg > runtimeStage.lastIndexOf('\nCOPY '),
    'The per-commit revision must not invalidate stable runtime filesystem layers',
  );

  const buildStep = namedWorkflowStep(workflow, 'Build and push');
  assert.match(buildStep, /uses: docker\/build-push-action@/);
  assert.match(
    buildStep,
    /build-args:\s*\|\s*APP_BUILD_REVISION=\$\{\{ github\.sha \}\}/,
  );
});

test('every base image is pinned to a digest, and both stages share it', () => {
  // Ein Tag wie node:24-slim ist eine Behauptung ueber das Image, der Digest ist
  // das Image. Dependabot (docker) hebt Digest und Tag zusammen; ein FROM ohne
  // Digest wuerde beim naechsten Bump lautlos zurueckfallen.
  const froms = dockerfile.split('\n').filter((l) => /^FROM /.test(l));
  assert.ok(froms.length >= 2, 'expected a build and a runtime stage');
  const digests = froms.map((l) => l.match(/^FROM node:(\d+)-slim@(sha256:[0-9a-f]{64})(?:\s+AS\s+\w+)?$/));
  digests.forEach((m, i) => assert.ok(m, `FROM line ${i + 1} must be node:<major>-slim@sha256:<digest>: ${froms[i]}`));
  assert.equal(new Set(digests.map((m) => m[2])).size, 1, 'build and runtime stage must pin the same digest');
});

test('CI tests the Node major the image runs on', () => {
  // Bis zum 4.9.2026 lief die CI auf 22.x, das Image auf 24: kein Test hatte je
  // die Version gesehen, die bei den Nutzern laeuft. Die Matrix muss den Major
  // des Dockerfiles enthalten; die Entwicklungs-Baseline aus package.json engines
  // bleibt daneben stehen.
  const imageMajor = dockerfile.match(/^FROM node:(\d+)-slim@/m)?.[1];
  assert.ok(imageMajor, 'Dockerfile must name a Node major');
  const matrix = ci.match(/node-version:\s*\[([^\]]+)\]/)?.[1];
  assert.ok(matrix, 'ci.yml must have a node-version matrix');
  const majors = matrix.split(',').map((v) => v.trim().replace(/\.x$/, ''));
  assert.ok(majors.includes(imageMajor), `CI matrix [${matrix}] must include the image's Node ${imageMajor}`);
});

test('CI tests Node 24 and 26, the supported span of engines.node', () => {
  const matrix = ci.match(/node-version:\s*\[([^\]]+)\]/)?.[1];
  assert.ok(matrix, 'ci.yml must have a node-version matrix');
  const majors = matrix.split(',').map((v) => v.trim().replace(/\.x$/, ''));
  assert.deepEqual(majors, ['24', '26'], `CI matrix [${matrix}] must be [24.x, 26.x]`);
});

test('the image carries provenance and an SBOM, and is signed by digest under both names', () => {
  // Eine Signatur per TAG waere wertlos: das Tag kann nachtraeglich verschoben
  // werden, der Digest nennt genau den Index, der eben gepusht wurde. Beide
  // Bildnamen (yuvomi und der oikos-Spiegel) teilen ihn, also brauchen beide
  // die Signatur - ein Legacy-Setup prueft sonst gegen ein unsigniertes Bild.
  const buildStep = namedWorkflowStep(workflow, 'Build and push');
  assert.match(buildStep, /^\s+id: build$/m, 'the build step must expose its digest under a stable id');
  assert.match(buildStep, /^\s+provenance: true$/m);
  assert.match(buildStep, /^\s+sbom: true$/m);

  const signStep = namedWorkflowStep(workflow, 'Sign the image');
  assert.match(signStep, /DIGEST: \$\{\{ steps\.build\.outputs\.digest \}\}/);
  const signs = signStep.match(/cosign sign --yes "[^"]*@\$\{DIGEST\}"/g) || [];
  assert.equal(signs.length, 2, 'both image names must be signed by digest');
  assert.ok(signs.some((l) => l.includes('${REGISTRY}/${IMAGE_NAME}@')), 'primary image signed');
  assert.ok(signs.some((l) => l.includes('${MIRROR}@')), 'oikos mirror signed');
  assert.match(signStep, /oikos|MIRROR/);
  assert.doesNotMatch(signStep, /cosign sign --yes "[^"]*:\$\{\{/, 'never sign by tag');

  const permissions = workflow.slice(workflow.indexOf('\npermissions:'), workflow.indexOf('\nenv:'));
  assert.match(permissions, /^\s+id-token: write$/m, 'keyless signing needs the OIDC token');
  assert.match(workflow, /uses: sigstore\/cosign-installer@[0-9a-f]{40} # v/);

  // DIE COSIGN-VERSION WIRD GEPINNT, NICHT GEERBT. Ohne `cosign-release` nimmt die
  // Action ihren Default, und der wandert mit IHRER Hauptversion: Installer v3.10.1
  // bringt cosign v2.6.1, v4.1.2 braechte v3.0.6 - und cosign 3 legt
  // Container-Signaturen als OCI-1.1-Referring-Artifact ab statt nach der alten
  // Tag-Konvention. Ein Dependabot-Bump der Action wuerde dieses Format also still
  // umstellen: der Build bliebe gruen, brechen wuerde es beim Betreiber, der mit
  // seiner eigenen cosign-Fassung den Befehl aus installation.md faehrt. Diese
  // Zusicherung ist der einzige Ort, der den Wechsel zu einer ENTSCHEIDUNG macht.
  assert.match(
    workflow,
    /uses: sigstore\/cosign-installer@[0-9a-f]{40} # v[^\n]*\n\s+with:\n\s+cosign-release: 'v\d+\.\d+\.\d+'/,
    'der cosign-installer braucht ein explizites cosign-release - sonst erbt die '
    + 'Signatur ihr Format von der Hauptversion der Action',
  );
});

test('the installation guide verifies against this workflow identity', () => {
  // Der Verify-Befehl ist die Zusage nach aussen. Er muss den OIDC-Issuer von
  // GitHub und den Pfad DIESER Workflow-Datei an einem Release-Tag nennen; ein
  // umbenannter Workflow liesse jeden Betreiber ins Leere pruefen, und ein
  // Muster ohne "refs/tags/v" wuerde auch den beweglichen main-Build annehmen.
  const block = installation.match(/cosign verify[\s\S]*?refs\/tags\/v'/);
  assert.ok(block, 'installation.md must show a cosign verify command');
  assert.match(block[0], /--certificate-oidc-issuer https:\/\/token\.actions\.githubusercontent\.com/);
  assert.match(block[0], /--certificate-identity-regexp '\^https:\/\/github\.com\/ulsklyc\/yuvomi\/\.github\/workflows\/docker-publish\.yml@refs\/tags\/v'/);
  assert.match(workflow, /^name: Docker Publish$/m);
});

test('the image workflow keeps read-only repository contents', () => {
  // Writing to releases belongs to release-assets.yml alone (phase 1a, A1):
  // that workflow uploads the tarball and publishes the release. The image
  // build runs on every push to main and needs packages, not the repository.
  const permissions = workflow.slice(workflow.indexOf('\npermissions:'), workflow.indexOf('\nenv:'));
  assert.match(permissions, /^ {2}contents: read$/m, 'docker-publish.yml must keep contents: read');
  assert.doesNotMatch(workflow, /^\s+contents: write$/m, 'no contents: write anywhere in docker-publish.yml');
});

test('the image builds the web app and ships dist/ from the build stage, plus the shared source', () => {
  // Phase 1a, Abschnitt D: der Server liefert nur dist/ und bricht ohne ab.
  // public/ bleibt im Image (der Server importiert public/utils/ und liest
  // public/locales/), test/ nicht, und dist/ kommt nie aus dem Build-Kontext.
  const buildStage = dockerfile.slice(0, dockerfile.lastIndexOf('\nFROM '));
  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM ') + 1);
  assert.match(buildStage, /\nARG APP_BUILD_REVISION\nRUN APP_BUILD_REVISION="\$\{APP_BUILD_REVISION\}" npm run build\n/, 'the build stage builds with the revision');
  assert.match(buildStage, /\nENV PUPPETEER_SKIP_DOWNLOAD=true\n/, 'npm ci with devDependencies must not fetch a browser');
  assert.match(runtimeStage, /\nCOPY --from=build \/app\/dist \.\/dist\n/);
  assert.match(runtimeStage, /\nCOPY server\/ \.\/server\/\n/);
  assert.match(runtimeStage, /\nCOPY public\/ \.\/public\/\n/);
  assert.doesNotMatch(runtimeStage, /\nCOPY \. \.\n/, 'no blanket copy of the context into the runtime stage');
  assert.doesNotMatch(runtimeStage, /COPY test\//);
  const ignore = readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8').split('\n').map((l) => l.trim());
  assert.ok(ignore.includes('test/'), '.dockerignore keeps test/ out');
  // dist/ entsteht in der Build-Stage. Ein dist/ aus dem Arbeitsbaum (35 MB samt
  // Sourcemaps) hat im Kontext nichts verloren: es wuerde bei jedem lokalen
  // `docker build` zum Daemon geschickt, und ein spaeteres `COPY dist/` naehme
  // still den Stand des Entwicklerrechners statt den der Build-Stage (#2636).
  assert.ok(ignore.includes('dist/'), '.dockerignore keeps a dist/ from the working tree out of the build context');
  assert.doesNotMatch(dockerfile, /^COPY (?!--from=)[^\n]*\bdist\b/m, 'dist/ is never copied from the build context, only from the build stage');
  for (const need of ['!scripts/build/', '!scripts/build-third-party-notices.mjs']) assert.ok(ignore.includes(need), `${need} missing in .dockerignore`);
});

test('the build stage copies every file the Vite config imports, before npm run build', async () => {
  // Codex auf #2631: dev-proxy.ts importierte server/utils/bind-address.js,
  // die Build-Stage kopiert kein server/, und `npm run build` im Image fiel
  // mit ERR_MODULE_NOT_FOUND. Die CI baut das Image nur am Tag. Geprueft wird
  // der Importgraph ab vite.config.ts, den der Config-Bundler aufloest
  // (relative Importe, statisch und dynamisch mit festem Pfad; Pakete und node:
  // liefert npm ci) gegen die COPY-Zeilen vor dem Build und gegen die
  // Ausnahmen in .dockerignore.
  const { existsSync } = await import('node:fs');
  const { posix } = await import('node:path');
  const { moduleSpecifiers } = await import('./source-text.js');
  const root = new URL('../', import.meta.url);
  const buildStage = dockerfile.slice(0, dockerfile.lastIndexOf('\nFROM '));
  const beforeBuild = buildStage.slice(0, buildStage.indexOf('npm run build'));
  assert.ok(beforeBuild.length < buildStage.length, 'the build stage runs npm run build');
  const copied = [...beforeBuild.matchAll(/^COPY (?!--from)(.+) \S+$/gm)].flatMap((m) => m[1].trim().split(/\s+/));
  const ignore = readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  /** @param {string} rel */
  const copiedBy = (rel) => copied.some((src) => (src.endsWith('/') ? rel.startsWith(src) : src.includes('*') ? new RegExp(`^${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[^/]*')}$`).test(rel) : rel === src));
  /** @param {string} rel */
  const ignored = (rel) => {
    let out = false;
    for (const line of ignore) {
      const neg = line.startsWith('!');
      const pat = neg ? line.slice(1) : line;
      const hit = pat.endsWith('/') ? rel.startsWith(pat) : rel === pat;
      if (hit) out = !neg;
    }
    return out;
  };
  const seen = new Set(['vite.config.ts']);
  const queue = ['vite.config.ts'];
  while (queue.length) {
    const rel = /** @type {string} */ (queue.shift());
    // Vite buendelt die Konfiguration vor dem Laden (Rolldown): auch ein
    // dynamischer Import mit festem Pfad wird dabei aufgeloest, ob er laeuft oder nicht.
    const { static: statics, dynamic } = moduleSpecifiers(readFileSync(new URL(rel, root), 'utf8'));
    for (const spec of [...statics, ...dynamic]) {
      if (!spec.startsWith('.')) continue;
      const dep = posix.normalize(posix.join(posix.dirname(rel), spec));
      assert.ok(existsSync(new URL(dep, root)), `${rel} imports ${spec}, which does not exist`);
      if (!seen.has(dep)) { seen.add(dep); queue.push(dep); }
    }
  }
  assert.ok(seen.size >= 5, `only ${seen.size} files in the config graph - the reader does not follow imports`);
  const missing = [...seen].filter((rel) => !copiedBy(rel) || ignored(rel));
  assert.deepEqual(missing, [], 'npm run build in the image needs these files, the build stage does not copy them (or .dockerignore drops them)');
});
