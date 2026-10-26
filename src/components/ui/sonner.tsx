import { Toaster as Sonner } from 'sonner';

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = (props: ToasterProps) => {
  return (
    <Sonner
      theme='dark'
      // Mini player snaps to corners — center bottom is the only edge it never occupies.
      position='bottom-center'
      expand
      visibleToasts={3}
      gap={8}
      // Top-center toasts must clear the 32px frameless titlebar.
      offset={{ top: '48px', bottom: '20px', left: '16px', right: '16px' }}
      mobileOffset={{ top: '48px', bottom: '12px', left: '12px', right: '12px' }}
      className='toaster group'
      toastOptions={{
        classNames: {
          // Custom cards inherit these classNames — scope chrome to styled toasts.
          toast:
            'group toast group-[.toaster]:data-[styled=true]:gap-2.5 group-[.toaster]:data-[styled=true]:rounded-[10px] group-[.toaster]:data-[styled=true]:border-white/[0.1] group-[.toaster]:data-[styled=true]:bg-[#17171b]/98 group-[.toaster]:data-[styled=true]:p-2.5 group-[.toaster]:data-[styled=true]:text-[13px] group-[.toaster]:data-[styled=true]:text-white/95 group-[.toaster]:data-[styled=true]:shadow-[0_8px_24px_-10px_rgb(0_0_0/0.65),0_1px_2px_rgb(0_0_0/0.35),inset_0_1px_0_rgb(255_255_255/0.04)]',
          title:
            'group-[.toast]:text-[13px] group-[.toast]:font-medium group-[.toast]:leading-5 group-[.toast]:tracking-[-0.005em] group-[.toast]:text-white/95',
          description:
            'group-[.toast]:text-[12px] group-[.toast]:leading-4 group-[.toast]:text-white/50',
          icon: 'group-data-[type=success]:text-emerald-400/90 group-data-[type=error]:text-red-300 group-data-[type=warning]:text-amber-300/90 group-data-[type=info]:text-sky-300/90',
          actionButton:
            'group-[.toast]:rounded-md! group-[.toast]:bg-white/[0.08]! group-[.toast]:text-[12px]! group-[.toast]:font-medium group-[.toast]:text-white! group-[.toast]:hover:bg-white/[0.12]!',
          cancelButton:
            'group-[.toast]:rounded-md! group-[.toast]:bg-white/[0.08]! group-[.toast]:text-[12px]! group-[.toast]:font-medium group-[.toast]:text-white! group-[.toast]:hover:bg-white/[0.12]!',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
