/** Index concrete test call sites. Presence is NOT a claim about assertion quality or full isolation coverage. */
import fs from 'node:fs';
import ts from 'typescript';

type Evidence = { source: string; test: string };
type Http = Evidence & { method: string; path: string };
const http: Http[] = [], domain = new Map<string, Evidence[]>();
function template(n: ts.Expression | undefined): string | undefined {
  if (!n) return;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map(s => ':arg' + s.literal.text).join('');
}
for (const name of fs.readdirSync('src/admin').filter(n => n.endsWith('.spec.ts'))) {
  const path = `src/admin/${name}`, file = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  function visit(n: ts.Node, test = '') {
    if (ts.isCallExpression(n) && ['it','test'].includes(n.expression.getText(file))) test = template(n.arguments[0]) ?? test;
    if (test && ts.isCallExpression(n)) {
      const ev = { source: `${path}:${file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1}`, test };
      let method: string | undefined, route: string | undefined;
      if (n.expression.getText(file) === 'call' && name === 'rbac-scope.integration.spec.ts') {
        method = template(n.arguments[0]); route = template(n.arguments[1]);
        if (route) route = '/admin/' + route;
      } else if (ts.isPropertyAccessExpression(n.expression)) {
        const prop = n.expression.name.text, obj = n.expression.expression.getText(file);
        if (/^(get|post|patch|put|delete)$/.test(prop)) {
          method = prop; route = template(n.arguments[0]);
        }
        if (/^(service|svc|admin)$/.test(obj)) domain.set(prop, [...(domain.get(prop) ?? []), ev]);
      }
      if (method && route?.startsWith('/api/v1/admin/')) route = route.slice(7);
      if (method && route?.startsWith('/admin/')) http.push({ ...ev, method: method.toUpperCase(), path: route.split('?')[0]! });
    }
    ts.forEachChild(n, c => visit(c, test));
  }
  visit(file);
}
const rows = JSON.parse(fs.readFileSync('docs/rbac/endpoint-inventory.json','utf8')) as {method:string;path:string;scope:string;service:{name:string;source:string}[];controller:string}[];
const matches = (pattern:string, actual:string) => {
  const a=pattern.split('/'), b=actual.split('/');
  return a.length === b.length && a.every((part,i)=>part.startsWith(':') || part === b[i]);
};
const uniq = (xs: Evidence[]) => [...new Map(xs.map(x=>[`${x.source}:${x.test}`,x])).values()];
const indexed = rows.map(row => ({
  method:row.method, path:row.path, scope:row.scope, controller:row.controller, service:row.service,
  directHttpTestCalls:uniq(http.filter(h=>h.method === row.method && matches(row.path,h.path)).map(({source,test})=>({source,test}))),
  domainServiceTestCalls:uniq(row.service.flatMap(s=>domain.get(s.name) ?? [])),
}));
const counts = {
  endpoints:indexed.length,
  withDirectHttpCall:indexed.filter(x=>x.directHttpTestCalls.length).length,
  domainOnly:indexed.filter(x=>!x.directHttpTestCalls.length && x.domainServiceTestCalls.length).length,
  sourceReviewOnly:indexed.filter(x=>!x.directHttpTestCalls.length && !x.domainServiceTestCalls.length).length,
};
fs.writeFileSync('docs/rbac/endpoint-evidence.json', JSON.stringify({
  interpretation:'Static pointers to tests; latest execution result is recorded in implementation-status.md. Direct calls can test allow, deny, invalid input or lifecycle; inspect assertions. This index excludes dynamic super-route scan and does not prove isolation for every route. Domain calls do not exercise HTTP guard. Source-only rows require explicit review.',
  counts, endpoints:indexed,
},null,2)+'\n');
console.log(JSON.stringify(counts));
console.log('Source-review-only routes:\n'+indexed.filter(x=>!x.directHttpTestCalls.length && !x.domainServiceTestCalls.length).map(x=>`${x.method} ${x.path}`).join('\n'));
