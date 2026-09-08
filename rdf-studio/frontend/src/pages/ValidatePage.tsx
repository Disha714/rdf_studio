import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FileText } from 'lucide-react';
import { api, compact, type ValidationTerm } from '../api';
import { ErrorBox, Page } from '../components/Page';

const term = (value: ValidationTerm) => value ? compact(value.value) : '—';
const constraintText = (constraint: { type: string; value: string }) => `${constraint.type}: ${compact(constraint.value)}`;

export function ValidatePage() {
  const v = useMutation({ mutationFn: api.validate });
  const failedRules = v.data?.rules.filter(rule => rule.status === 'failed') ?? [];
  const passedRules = v.data?.rules.filter(rule => rule.status === 'passed') ?? [];

  return <Page className="validate-page" title="SHACL validation" description="Check the current dataset against pipeline integrity constraints." actions={<button onClick={() => v.mutate()} disabled={v.isPending}>{v.isPending ? 'Validating…' : 'Run validation'}</button>}>
    <ErrorBox error={v.error} />
    {v.data ? <>
      <div className={`status card ${v.data.conforms ? 'valid' : 'invalid'}`}>
        <strong>{v.data.conforms ? 'Dataset conforms' : 'Violations found'}</strong>
        <span>{v.data.triples} triples evaluated · {v.data.rules.length} rules checked · {failedRules.length} failed</span>
      </div>

      <div className="validation-summary">
        <div className="validation-metric card"><CheckCircle2 size={19} /><span>Passed rules</span><strong>{passedRules.length}</strong></div>
        <div className="validation-metric card"><AlertTriangle size={19} /><span>Violations</span><strong>{v.data.violations.length}</strong></div>
        <div className="validation-metric card"><FileText size={19} /><span>Triples evaluated</span><strong>{v.data.triples}</strong></div>
      </div>

      <section className="validation-section card">
        <div className="validation-section-head">
          <div><h2>Rules checked</h2><p>These SHACL constraints were evaluated against the current RDF dataset.</p></div>
        </div>
        <div className="validation-rule-list">
          {v.data.rules.map(rule => <div className={`validation-rule ${rule.status}`} key={rule.id}>
            <div className="validation-rule-main">
              <span className="rule-status">{rule.status === 'passed' ? 'Passed' : 'Failed'}</span>
              <strong>{rule.message}</strong>
              <small>Target class: {term(rule.targetClass)} · Property path: {term(rule.path)} · {rule.targetCount} target node{rule.targetCount === 1 ? '' : 's'}</small>
            </div>
            <div className="validation-rule-meta">
              {rule.constraints.map((constraint, index) => <code key={`${constraint.type}-${index}`}>{constraintText(constraint)}</code>)}
              <em>{rule.violationCount} violation{rule.violationCount === 1 ? '' : 's'}</em>
            </div>
          </div>)}
        </div>
      </section>

      <section className="validation-section card">
        <div className="validation-section-head">
          <div><h2>Violation details</h2><p>When validation fails, each row identifies the resource, RDF property, value, and failing constraint.</p></div>
        </div>
        {v.data.violations.length ? <div className="table-wrap">
          <table>
            <thead><tr><th>Resource</th><th>Property</th><th>Value</th><th>Constraint</th><th>Message</th></tr></thead>
            <tbody>{v.data.violations.map((violation, index) => <tr key={index}>
              <td><code>{term(violation.focusNode)}</code></td>
              <td><code>{term(violation.path)}</code></td>
              <td>{violation.value ? <code>{term(violation.value)}</code> : '—'}</td>
              <td><code>{term(violation.constraint)}</code></td>
              <td>{violation.message}</td>
            </tr>)}</tbody>
          </table>
        </div> : <div className="section-empty">No violations found. All listed SHACL rules passed.</div>}
      </section>

      <details className="validation-raw card">
        <summary>Raw pySHACL report</summary>
        <pre className="result">{v.data.report}</pre>
      </details>
    </> : <div className="empty">Run validation to see the SHACL report.</div>}
  </Page>;
}
