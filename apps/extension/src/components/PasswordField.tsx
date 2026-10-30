import { useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button as BaseButton, Field } from "@base-ui-components/react";
import { FieldShell, inputChrome } from "./FieldShell";
import { Icon } from "./Icon";

function EyeIcon() {
  return (
    <Icon size={16}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

function EyeOffIcon() {
  return (
    <Icon size={16}>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </Icon>
  );
}

/**
 * Secret input with a show/hide eye toggle — use for API keys and tokens.
 * Same Field wiring as TextField (label, description).
 */
export function PasswordField({
  label,
  hint,
  ...props
}: ComponentProps<typeof Field.Control> & { label?: string; hint?: ReactNode }) {
  const [show, setShow] = useState(false);
  const { t } = useTranslation();
  return (
    <FieldShell label={label} hint={hint}>
      <div className="relative">
        <Field.Control
          type={show ? "text" : "password"}
          className={`${inputChrome} w-full px-3 py-2 pr-9`}
          {...props}
        />
        <BaseButton
          type="button"
          aria-label={show ? t("common.hideKey") : t("common.showKey")}
          aria-pressed={show}
          onClick={() => setShow((s) => !s)}
          className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-lg text-neutral-400 hover:text-neutral-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-neutral-500 dark:hover:text-neutral-300"
        >
          {show ? <EyeOffIcon /> : <EyeIcon />}
        </BaseButton>
      </div>
    </FieldShell>
  );
}
