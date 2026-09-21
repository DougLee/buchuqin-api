/** Regenerate review pointers; this inventory is not a runtime isolation test. */
import 'reflect-metadata';
import fs from 'node:fs';
import ts from 'typescript';
import { listAdminRoutes, concreteRoute } from '../src/admin/rbac/route-inventory';
import { MENU_NODES, ADMIN_URL_WHITELIST } from '../src/admin/rbac/registry';
import { matchUrl } from '../src/admin/rbac/rbac.service';
import { isSuperOnlyOperation, PLATFORM_PATTERNS } from '../src/admin/rbac/access-policy';

const controllerPath = 'src/admin/admin.controller.ts';
const servicePath = 'src/admin/admin.service.ts';
const parse = (path: string) => ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
const ctrl = parse(controllerPath), svc = parse(servicePath);
const methods = (file: ts.SourceFile) => file.statements.flatMap(n => ts.isClassDeclaration(n) ? n.members.filter(ts.isMethodDeclaration) : []);
const svcMethods = new Map(methods(svc).map(m => [m.name.getText(svc), m]));
const pointer = (file: ts.SourceFile, n: ts.Node) => `${file.fileName}:${file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1}`;
const handlers = new Map<string, ts.MethodDeclaration>();
for (const m of methods(ctrl)) for (const d of ts.getDecorators(m) ?? []) {
  if (!ts.isCallExpression(d.expression)) continue;
  const verb = d.expression.expression.getText(ctrl).toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(verb)) continue;
  const arg = d.expression.arguments[0];
  if (arg && ts.isStringLiteral(arg)) handlers.set(`${verb} /admin/${arg.text}`, m);
}
function scope(method: string, path: string): string {
  if (isSuperOnlyOperation(method, path)) return 'super-only: global permission configuration/account administration';
  if (matchUrl(PLATFORM_PATTERNS, method, concreteRoute({method,path}).path)) return 'platform-only: global resource or explicit target campus';
  if (ADMIN_URL_WHITELIST.has(`${method} ${path}`)) return 'self: current account effective permissions; no other account data';
  if (/^\/admin\/(campus-config|delivery-slots|notices)(\/|$)/.test(path)) return 'campusScope: current campus; matching operation platform grant permits selected campus or owned-record lookup';
  if (path.startsWith('/admin/categories')) return 'shared: global category dictionary; capability required for mutations';
  if (path === '/admin/products/official-library') return 'shared: official catalog; excludes private campus product rows';
  if (path.startsWith('/admin/products')) return 'productCampus: current campus; operation platform grant permits official view; field capabilities independently checked';
  if (path === '/admin/staff' && method === 'POST' || path.startsWith('/admin/staff/') && method !== 'GET') return 'staff: source current campus plus destination check; matching platform grant permits cross-campus';
  if (/^\/admin\/restock\/batches(?:\/:id)?$/.test(path) && method === 'GET') return 'shared batch metadata; embedded orders/counts current campus unless matching platform grant';
  if (/^\/admin\/restock\/orders/.test(path) && method === 'GET') return 'orders/shipment: current campus unless matching platform grant';
  if (path.startsWith('/admin/restock')) return 'current campus order/receipt; batch shared; nested product/receipt validation in service';
  if (/^\/admin\/(dashboard|inventory|marketing\/map|users|audit-logs|recruit-applications)(\/|$)/.test(path) || path === '/admin/reports/campus-daily' || path === '/admin/campuses' || path === '/admin/buildings' && method === 'GET' || /^\/admin\/orders(?:\/(status-counts|new-order-watch))?$/.test(path) && method === 'GET') return 'campusScope: current campus; matching platform grant permits aggregate or validated campus query';
  if (/^\/admin\/(banners|promotions|featured|orders|printers|wechat-groups|wheel|locations|staff|leave-requests|dispatch-invitations|delivery-config|buildings|battle-map|after-sales|commission-rules|settlements|coupons)(\/|$)/.test(path)) return 'account campus context: body/query cannot override scope; service must validate target and nested IDs';
  throw new Error(`Unclassified route ${method} ${path}`);
}
const rows = listAdminRoutes().map(route => {
  const handler = handlers.get(`${route.method} ${route.path}`);
  if (!handler) throw new Error(`Missing handler ${route.path}`);
  const calls = [...handler.getText(ctrl).matchAll(/this\.service\.(\w+)\(/g)].map(m => m[1]);
  return {
    ...route,
    nodes: MENU_NODES.filter(n => matchUrl(n.perms ?? [], route.method, concreteRoute(route).path)).map(n => n.code),
    scope: scope(route.method, route.path),
    controller: pointer(ctrl, handler),
    service: [...new Set(calls)].map(name => ({ name, source: svcMethods.has(name) ? pointer(svc, svcMethods.get(name)!) : 'delegated service' })),
    verification: 'Source review pointers only; valid-target isolation evidence is tracked separately in data-scope-matrix.md',
  };
});
fs.writeFileSync('docs/rbac/endpoint-inventory.json', JSON.stringify(rows, null, 2) + '\n');
console.log(`Wrote ${rows.length} routes with explicit scope classification and source pointers`);
