import { Toaster as Sonner } from 'sonner';

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = (props: ToasterProps) => {
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
            'group toast group-[.toaster]:data-[styled=true]:rounded-xl group-[.toaster]:data-[styled=true]:border-white/[0.08] group-[.toaster]:data-[styled=true]:bg-[#111114]/95 group-[.toaster]:data-[styled=true]:text-[13px] group-[.toaster]:data-[styled=true]:text-zinc-100 group-[.toaster]:data-[styled=true]:shadow-[0_18px_44px_-14px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,255,255,0.05)] group-[.toaster]:data-[styled=true]:backdrop-blur-xl',
          description: 'group-[.toast]:text-zinc-400',
          actionButton:
            'group-[.toast]:rounded-md! group-[.toast]:bg-white/10! group-[.toast]:font-medium group-[.toast]:text-white! group-[.toast]:hover:bg-white/15!',
          cancelButton: 'group-[.toast]:bg-white/[0.04] group-[.toast]:text-zinc-400',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
