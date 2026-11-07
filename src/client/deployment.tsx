/**
 * 面板 Settings 标签页的部署设置视图。
 * 独立版本不再内嵌 DSH 的插件配置表单：主机级配置来自启动时读取的配置文件，这里只读展示。
 */
import { LIMITS } from '../limits.ts'
import type { SetupView } from './api.ts'
import { InfoTip, Input } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Field, Fields } from './settings-kit.tsx'
import { setupText } from './text.ts'
import { CheckSetupButton, Hint, KeyValues, Section, SetupMessage } from './widgets.tsx'

const MACHINE_LIMITS = ['promptMaxChars', 'admissionContextMaxPages', 'admissionContextTimeoutMs'] as const

/** 部署配置视图：只读展示状态目录、运行限制与派生的仓库/账号信息。 */
export function DeploymentPage({ setup, accounts: showAccounts }: { setup: SetupView; accounts?: boolean }) {
  const { t } = usePanel()
  const accounts = setup.accounts
  const feishu = accounts?.feishu ? accounts.feishu.name || accounts.feishu.botId
    : setup.feishuProblem ? setupText(t, setup.feishuProblem) : t('deploymentFeishuNone')
  const limit = (key: typeof MACHINE_LIMITS[number], label: string) => <Field label={label}>
    <Input type="number" min={LIMITS[key].min} max={LIMITS[key].max} step={1} value={setup.machine[key]} disabled />
  </Field>
  return <form className="dt-form" onSubmit={event => event.preventDefault()}>
    {/* 检查按钮要能点击，因此放在禁用的字段组之外；只读字段仍整体禁用。 */}
    {setup.problem && <div className="dt-row-buttons">
      <p className="dt-error" role="status"><SetupMessage problem={setup.problem} lead /></p><CheckSetupButton />
    </div>}
    <Fields disabled>
      <Hint>{t('deploymentIntro')}</Hint>
      {showAccounts && <Section title={t('deploymentDerived')} hint={t('deploymentDerivedHint')}>
        <KeyValues rows={[[t('deploymentRepository'), accounts?.repository ?? '—'],
          [t('deploymentAgent'), accounts ? `@${accounts.agent}` : '—'], [t('deploymentFeishu'), feishu]]} />
        <Hint>{t('deploymentAccountsWhere')}</Hint>
      </Section>}
      <Section title={t('deploymentMachine')}>
        <Hint>{t('deploymentConfigFile')}</Hint>
        <div className="dt-field">
          <span className="dt-field-head">{t('deploymentStateDir')}<InfoTip text={t('deploymentStateDirHint')} /></span>
          <span className="dt-mono">{setup.machine.stateDir}</span>
        </div>
      </Section>
      <Section title={t('deploymentLimits')} hint={t('deploymentLimitsHint')}>
        {limit('promptMaxChars', t('deploymentPromptMaxChars'))}
        {limit('admissionContextMaxPages', t('deploymentContextPages'))}
        {limit('admissionContextTimeoutMs', t('deploymentContextTimeout'))}
      </Section>
    </Fields>
  </form>
}
