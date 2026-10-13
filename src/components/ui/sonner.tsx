import { Toaster as Sonner } from 'sonner';

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme='dark'
      // Mini player snaps to corners — center bottom is the only edge it never occupies.
      position='bottom-center'
      // Top-center toasts must clear the 32px frameless titlebar.
      offset={{ top: '48px' }}
      className='toaster group'
      toastOptions={{
        classNames: {
          // Custom pills render `data-styled="false"` but inherit these classNames — scope to styled toasts.
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
