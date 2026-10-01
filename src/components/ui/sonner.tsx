import { Toaster as Sonner } from 'sonner';

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme='dark'
      // Mini player snaps to corners; center bottom is the only edge slot it
      // can never occupy.
      position='bottom-center'
      // Action-confirmation toasts opt into top-center per call — lift that
      // edge past the 32px frameless titlebar so the pill clears it.
      offset={{ top: '48px' }}
      className='toaster group'
      toastOptions={{
        classNames: {
          // `unstyled`/`toast.custom` pills render `data-styled="false"` but
          // still inherit these classNames — scope them to styled toasts so
          // a custom card isn't wrapped in a bg/border/shadow bar.
          toast:
            'group toast group-[.toaster]:data-[styled=true]:bg-background group-[.toaster]:data-[styled=true]:text-foreground group-[.toaster]:data-[styled=true]:border-border group-[.toaster]:data-[styled=true]:shadow-lg',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton: 'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
