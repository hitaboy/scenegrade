type $$ComponentProps = {
    value: number;
    min: number;
    max: number;
    step?: number;
    label: string;
    reset?: number;
    unit?: string;
    digits?: number;
    onchange: (v: number) => void;
    width?: string;
    bipolar?: boolean;
};
declare const Slider: import("svelte").Component<$$ComponentProps, {}, "">;
type Slider = ReturnType<typeof Slider>;
export default Slider;
