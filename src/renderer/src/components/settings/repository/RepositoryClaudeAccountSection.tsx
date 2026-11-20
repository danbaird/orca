import { useEffect, useId, useState } from 'react'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import type { Repo } from '../../../../../shared/repo-types'
import type { ClaudeManagedAccountSummary as ClaudeManagedAccount } from '../../../../../shared/managed-account-types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { searchKeywords } from '../search/settings-search-keywords'

// Radix forbids empty item values; this stands for "no repo pin".
const GLOBAL_VALUE = '__global_claude_account__'

function findPinnedAccount(
  accounts: readonly ClaudeManagedAccount[],
  reference: string
): ClaudeManagedAccount | undefined {
  const needle = reference.trim().toLowerCase()
  return (
    accounts.find((account) => account.id === reference.trim()) ??
    accounts.find((account) => account.email.toLowerCase() === needle)
  )
}

function accountLabel(account: ClaudeManagedAccount): string {
  return account.organizationName ? `${account.email} (${account.organizationName})` : account.email
}

export function RepositoryClaudeAccountSection({
  repo,
  forceVisible
}: {
  repo: Repo
  forceVisible?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const labelId = useId()
  const savedAccountCount = useAppStore((state) => state.settings?.claudeManagedAccounts.length)
  const [saved, setSaved] = useState<readonly ClaudeManagedAccount[]>([])
  const pins = useAppStore((state) => state.settings?.claudeAccountByRepo)
  const updateSettings = useAppStore((state) => state.updateSettings)
  useEffect(() => {
    let cancelled = false
    void window.api.claudeAccounts
      .list()
      .then((state) => !cancelled && setSaved(state.accounts))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [savedAccountCount])
  const reference = pins?.[repo.id] ?? ''
  const pinned = reference ? findPinnedAccount(saved, reference) : undefined
  const unavailable = reference !== '' && (!pinned || pinned.needsSignIn === true)

  const select = (value: string): void => {
    const next = { ...pins }
    if (value === GLOBAL_VALUE) {
      delete next[repo.id]
    } else {
      next[repo.id] = value
    }
    void updateSettings({ claudeAccountByRepo: next })
  }

  return (
    <SearchableSetting
      title={t('components.RepositoryClaudeAccountSection.title', 'Claude Account')}
      description={t(
        'components.RepositoryClaudeAccountSection.description',
        'Claude account used for agents launched in this project.'
      )}
      keywords={searchKeywords(
        [
          repo.displayName,
          {
            key: 'components.RepositoryClaudeAccountSection.keyword',
            fallback: 'claude account',
            aliases: ['claude', 'account', 'login', 'subscription']
          }
        ],
        t
      )}
      className="space-y-3 py-3"
      forceVisible={forceVisible}
    >
      <div className="space-y-1">
        <div id={labelId} className="text-sm font-semibold">
          {t('components.RepositoryClaudeAccountSection.title', 'Claude Account')}
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            'components.RepositoryClaudeAccountSection.description',
            'Claude account used for agents launched in this project.'
          )}
        </p>
      </div>
      <Select
        value={reference ? (pinned?.id ?? reference) : GLOBAL_VALUE}
        onValueChange={select}
        disabled={saved.length === 0 && !reference}
      >
        <SelectTrigger size="sm" className="w-full" aria-labelledby={labelId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={GLOBAL_VALUE}>
            {t(
              'components.RepositoryClaudeAccountSection.global',
              'Global account (Settings > Accounts)'
            )}
          </SelectItem>
          {reference && !pinned ? (
            <SelectItem value={reference} disabled>
              {t(
                'components.RepositoryClaudeAccountSection.missingOption',
                '{{account}} (not saved)',
                { account: reference }
              )}
            </SelectItem>
          ) : null}
          {saved.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              {account.needsSignIn
                ? t(
                    'components.RepositoryClaudeAccountSection.needsSignInOption',
                    '{{account}} (sign-in required)',
                    { account: accountLabel(account) }
                  )
                : accountLabel(account)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {saved.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'components.RepositoryClaudeAccountSection.empty',
            'No Claude accounts saved. Add one in Settings > Accounts.'
          )}
        </p>
      ) : null}
      {unavailable ? (
        <p role="alert" className="text-xs text-destructive">
          {t(
            'components.RepositoryClaudeAccountSection.unavailable',
            'This account is unavailable, so Claude will not launch in this project. Sign in again in Settings > Accounts or choose another account.'
          )}
        </p>
      ) : null}
    </SearchableSetting>
  )
}
