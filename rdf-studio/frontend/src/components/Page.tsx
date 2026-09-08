import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { notifyError } from '../toast';
export function Page({ title, description, actions, children, className }: { title: string; description: string; actions?: ReactNode; children: ReactNode; className?: string }) { return <div className={`page${className ? ` ${className}` : ''}`}><header className="page-header"><div><h1>{title}</h1><p>{description}</p></div>{actions}</header>{children}</div> }
export function ErrorBox({ error }: { error: unknown }) { useEffect(()=>{if(error)notifyError(error)},[error]); return error ? <div className="error">{error instanceof Error ? error.message : String(error)}</div> : null; }
