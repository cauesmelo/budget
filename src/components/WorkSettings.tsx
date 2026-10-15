import { useEffect, useId, useState } from 'react';
import { Briefcase, Check, Search } from 'lucide-react';
import { categoryNameKey, listCategories } from '../lib/categories';
import type { FinanceData } from '../lib/types';

interface WorkSettingsProps {
  data: FinanceData;
  onEdit: (edit: (current: FinanceData) => FinanceData) => boolean;
}

export function WorkSettings({ data, onEdit }: WorkSettingsProps) {
  const id = useId();
  const storedLabel = data.work?.label ?? 'Work';
  const storedRules = JSON.stringify(data.work?.expenseCategories ?? []);
  const storedUpdatedAt = data.work?.updatedAt;
  const [label, setLabel] = useState(storedLabel);
  const [rules, setRules] = useState<string[]>(() => JSON.parse(storedRules));
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    setLabel(storedLabel);
    setRules(JSON.parse(storedRules));
    setError('');
  }, [storedLabel, storedRules, storedUpdatedAt]);

  const categories = listCategories(data);
  const knownNames = new Set(categories.flatMap(category => [category.name, ...(category.aliases ?? [])]).map(categoryNameKey));
  const choices = [
    ...categories.map(category => ({
      key: category.id,
      name: category.name,
      names: new Set([category.name, ...(category.aliases ?? [])].map(categoryNameKey)),
      archived: Boolean(category.archivedAt),
      missing: false,
    })),
    ...rules.filter(name => !knownNames.has(categoryNameKey(name))).map(name => ({
      key: `missing-${name}`,
      name,
      names: new Set([categoryNameKey(name)]),
      archived: false,
      missing: true,
    })),
  ];
  const selectedNames = new Set(rules.map(categoryNameKey));
  const search = categoryNameKey(query);
  const visibleChoices = choices.filter(choice => [...choice.names].some(name => name.includes(search)));

  function toggle(names: Set<string>, name: string, checked: boolean) {
    setRules(current => {
      const next = current.filter(rule => !names.has(categoryNameKey(rule)));
      return checked ? [...next, name] : next;
    });
    setError('');
    setStatus('');
  }

  function save() {
    setError('');
    setStatus('');
    const name = label.normalize('NFC').trim().replace(/\s+/g, ' ') || 'Work';
    if (name.length > 120) {
      setError('Use a work label with no more than 120 characters.');
      return;
    }
    const expenseCategories = [...new Map(rules.map(rule => [categoryNameKey(rule), rule])).values()];
    try {
      const saved = onEdit(current => {
        const updatedAt = new Date().toISOString();
        return { ...current, work: { label: name, expenseCategories, updatedAt }, updatedAt };
      });
      if (!saved) {
        setError('Could not save work settings. Check your data and try again.');
        return;
      }
      setStatus('Work settings saved.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save work settings.');
    }
  }

  return <section className="panel work-settings-panel" aria-labelledby={`${id}-title`}>
    <div className="panel-header"><div><h2 id={`${id}-title`}>Work cash flow</h2><p>Keep reimbursable costs and reimbursements separate from your personal finances.</p></div><Briefcase size={21} /></div>
    <p className="work-settings-intro">In Transactions, set Scope for work expenses and reimbursements. Leave your salary as Personal. Work cash flow appears separately in the monthly overview.</p>
    <form onSubmit={event => { event.preventDefault(); save(); }}>
      <label className="field"><span>Work label</span><input aria-label="Work label" value={label} maxLength={120} placeholder="Work" autoComplete="off" onChange={event => { setLabel(event.target.value); setError(''); setStatus(''); }} /><small>For example, your employer or client name. Included in your backups and sync.</small></label>
      <fieldset className="work-settings-rules">
        <legend>Automatically classify expense categories</legend>
        <p id={`${id}-rules-help`}>Matching expenses, including refunds, use the work scope. Income is never classified automatically. An explicit transaction scope takes priority. Archived categories remain available here for historical records.</p>
        <div className="search"><Search size={16} /><input aria-label="Search work expense categories" placeholder="Search categories" value={query} onChange={event => setQuery(event.target.value)} /></div>
        <div className="work-settings-category-list" aria-describedby={`${id}-rules-help`}>
          {visibleChoices.map(choice => <label className="work-settings-category" key={choice.key}>
            <input type="checkbox" checked={[...choice.names].some(name => selectedNames.has(name))} onChange={event => toggle(choice.names, choice.name, event.target.checked)} />
            <span>{choice.name}{choice.archived && <small className="category-archived-badge">Archived</small>}{choice.missing && <small className="category-archived-badge">Missing from category catalog</small>}</span>
          </label>)}
          {!visibleChoices.length && <p>{query ? 'No categories match this search.' : 'No categories yet. You can still set a transaction’s scope manually.'}</p>}
        </div>
      </fieldset>
      <p className="footnote">You can leave every category unchecked and classify work transactions manually. Saving these rules updates the overview without changing transaction categories or amounts.</p>
      {error && <div className="alert error" role="alert">{error}</div>}
      {status && <div className="alert success" role="status"><Check size={16} />{status}</div>}
      <button type="submit" className="button">Save work settings</button>
    </form>
  </section>;
}
