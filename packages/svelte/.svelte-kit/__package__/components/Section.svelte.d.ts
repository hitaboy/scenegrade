import type { Snippet } from 'svelte';
type $$ComponentProps = {
    title: string;
    open?: boolean;
    children: Snippet;
    actions?: Snippet;
};
declare const Section: import("svelte").Component<$$ComponentProps, {}, "open">;
type Section = ReturnType<typeof Section>;
export default Section;
