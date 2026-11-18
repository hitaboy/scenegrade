type $$ComponentProps = {
    icon: string;
    label: string;
    active?: boolean;
    disabled?: boolean;
    shortcut?: string;
    onclick?: (e: MouseEvent) => void;
    size?: number;
    text?: string;
};
declare const IconButton: import("svelte").Component<$$ComponentProps, {}, "">;
type IconButton = ReturnType<typeof IconButton>;
export default IconButton;
