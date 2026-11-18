export interface Option {
    value: string;
    label: string;
    group?: string;
}
type $$ComponentProps = {
    value: string;
    options: Option[];
    label: string;
    onchange: (v: string) => void;
    width?: string;
    compact?: boolean;
};
declare const Select: import("svelte").Component<$$ComponentProps, {}, "">;
type Select = ReturnType<typeof Select>;
export default Select;
