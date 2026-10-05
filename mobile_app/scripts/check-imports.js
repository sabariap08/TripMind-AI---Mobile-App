const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcRoot = path.join(root, 'src');

const files = [];
(function walk(d) {
  fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  });
})(srcRoot);
files.push(path.join(root, 'App.js'), path.join(root, 'index.js'));

function exportsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = new Set();
  let m;
  let re = /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g;
  while ((m = re.exec(src))) out.add(m[1]);
  re = /export\s*\{([^}]+)\}/g;
  while ((m = re.exec(src))) {
    m[1].split(',').forEach((x) => {
      const t = x.trim();
      if (t) out.add(t.split(/\s+as\s+/).pop().trim());
    });
  }
  return out;
}

let problems = 0;

// 1. Every relative import must resolve to a real file.
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /import\s+([^;]*?)\s+from\s+'(\.[^']+)'/g;
  let m;
  while ((m = re.exec(src))) {
    const base = path.resolve(path.dirname(f), m[2]);
    const found = [base, base + '.js', path.join(base, 'index.js')].find(
      (c) => fs.existsSync(c) && fs.statSync(c).isFile(),
    );
    if (!found) {
      console.log('MISSING MODULE', path.relative(root, f), '->', m[2]);
      problems++;
      continue;
    }
    const ex = exportsOf(found);
    const braces = m[1].match(/\{([^}]*)\}/);
    if (!braces) continue;
    for (let name of braces[1].split(',')) {
      name = name.trim();
      if (!name) continue;
      const local = name.split(/\s+as\s+/)[0].trim();
      if (!ex.has(local)) {
        console.log('NO EXPORT', path.relative(root, f), '->', m[2], '::', local);
        problems++;
      }
    }
  }
}

// 2. No unused named imports. `...name` (object spread) counts as a use, since
//    theme.js styles are consumed that way everywhere.
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /import\s+\{([^}]*)\}\s+from\s+'[^']+';/g;
  let m;
  while ((m = re.exec(src))) {
    const after = src.slice(m.index + m[0].length);
    for (let name of m[1].split(',')) {
      name = name.trim();
      if (!name) continue;
      const local = name.split(/\s+as\s+/).pop().trim();
      const esc = local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Used if the identifier appears as a whole word and is not preceded by a
      // dot. The dot exclusion drops `foo.bar` style false hits, while still
      // counting `colors.brand700` (the identifier itself) and `space.lg`.
      const plain = new RegExp('(^|[^.A-Za-z0-9_$])' + esc + '(?![A-Za-z0-9_$])');
      // `...type.small` inside StyleSheet.create is the dominant usage of the
      // theme helpers, and the preceding character there is a dot from the
      // spread, so it needs its own check.
      const spread = new RegExp('\\.\\.\\.' + esc + '(?![A-Za-z0-9_$])');
      if (!plain.test(after) && !spread.test(after)) {
        console.log('UNUSED IMPORT', path.relative(root, f), '::', local);
        problems++;
      }
    }
  }
}

console.log('\n' + files.length + ' files checked, ' + problems + ' problems');
process.exit(problems ? 1 : 0);
